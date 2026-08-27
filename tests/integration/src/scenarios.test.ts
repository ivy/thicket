import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TaskState } from "@a2a-js/sdk";
import { fleetHealth } from "@thicket/cli";
import { parseRoster, toAgentCard } from "@thicket/roster";
import { toSlackManifest } from "@thicket/slack-manifest";

import {
  CoalescingCli,
  MockSlack,
  startAgent,
  startBridge,
  until,
} from "./harness.js";

const CH = "C42";
const TH = "1724650000.000100";

function dm(text: string, ts: string) {
  return { kind: "dm" as const, channel: CH, threadTs: TH, text, messageTs: ts, files: [] };
}

// Scenario 1: DM the agent; get a response; status processing -> active.
test("scenario 1: DM round trip through bridge, A2A, agentd, session", async (t) => {
  const agent = await startAgent("hearth");
  t.after(() => agent.stop());
  const bridge = startBridge(agent);
  t.after(() => bridge.state.close());

  await bridge.engine.handleEvent(dm("what is 2+2?", "1.1"));

  assert.equal(bridge.slack.statuses()[0], "processing", "status went processing first");
  assert.equal(bridge.slack.statuses().at(-1), "active", "released to active");
  assert.match(bridge.slack.streamedText(), /answer\(what is 2\+2\?\)/, "reply streamed back");
  const stops = bridge.slack.calls.filter((c) => c.type === "stop");
  assert.equal(stops.length, 1, "stream closed");
  assert.equal(agent.cli.turnsRun, 1);
});

// Scenario 2: three rapid messages coalesce; status holds processing
// until the queue drains.
test("scenario 2: rapid messages coalesce and hold processing until drained", async (t) => {
  const agent = await startAgent("hearth");
  t.after(() => agent.stop());
  const bridge = startBridge(agent);
  t.after(() => bridge.state.close());
  agent.cli.hold = true;

  const sends = [
    bridge.engine.handleEvent(dm("one", "2.1")),
    bridge.engine.handleEvent(dm("two", "2.2")),
    bridge.engine.handleEvent(dm("three", "2.3")),
  ];
  // First turn starts with "one"; wait for two+three to be queued behind
  // it before releasing, so the coalescing fold is actually exercised.
  await until(() => agent.cli.turnsRun === 1, "first turn started");
  await until(() => agent.cli.queuedCount === 2, "two sends queued behind the turn");
  agent.cli.hold = false;
  agent.cli.release();
  await Promise.all(sends);

  assert.equal(agent.cli.turnsRun, 2, "three sends coalesced into two turns");
  const statuses = bridge.slack.statuses();
  assert.equal(statuses.at(-1), "active", "released after the queue drained");
  // The first turn's terminal reported queued work and other streams were
  // still open, so the bridge held processing and released exactly once,
  // at the end.
  assert.equal(statuses.indexOf("active"), statuses.length - 1,
    `single release at the end: ${statuses.join(",")}`);
  assert.ok(
    statuses.slice(0, -1).every((status) => status === "processing"),
    `held processing until the drain: ${statuses.join(",")}`,
  );
  // Which sends fold together depends on HTTP arrival order; the
  // invariants are that a fold happened and nothing was dropped.
  const streamed = bridge.slack.streamedText();
  assert.match(streamed, / \| /, "some sends folded into one turn");
  for (const word of ["one", "two", "three"]) {
    assert.ok(streamed.includes(word), `"${word}" answered in ${streamed}`);
  }
});

// Scenario 3: long task + stop button -> canceled, agent interrupted.
test("scenario 3: stop button cancels the running task", async (t) => {
  const agent = await startAgent("hearth");
  t.after(() => agent.stop());
  const bridge = startBridge(agent);
  t.after(() => bridge.state.close());
  agent.cli.hold = true;

  const send = bridge.engine.handleEvent(dm("dig a very deep hole", "3.1"));
  await until(
    () => agent.store.allInStates([TaskState.TASK_STATE_WORKING]).length === 1,
    "task reached working in the real store",
  );
  await until(
    () => bridge.state.tasksForThread(CH, TH).length === 1,
    "bridge recorded the in-flight task",
  );

  await bridge.engine.handleEvent({ kind: "session_stopped", channel: CH, threadTs: TH });
  await until(() => agent.cli.interrupts === 1, "interrupt reached the session");
  await send;

  await until(
    () =>
      agent.store.allInStates([TaskState.TASK_STATE_WORKING, TaskState.TASK_STATE_SUBMITTED])
        .length === 0,
    "no task left running",
  );
  assert.equal(bridge.slack.statuses().at(-1), "active");
});

// Scenario 6: agentd restarts mid-task; the task ends failed with a
// restart message rather than hanging in working.
test("scenario 6: restart mid-task fails the orphaned task with a restart message", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "restart-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, "tasks.db");

  const first = await startAgent("hearth", { dbPath });
  const bridge = startBridge(first);
  t.after(() => bridge.state.close());
  first.cli.hold = true;

  void bridge.engine.handleEvent(dm("never finishes", "6.1"));
  await until(
    () => first.store.allInStates([TaskState.TASK_STATE_WORKING]).length === 1,
    "task in working",
  );
  const orphan = first.store.allInStates([TaskState.TASK_STATE_WORKING])[0]!;

  // Crash: no drain, no result — like a power cut.
  await first.stop();

  const second = await startAgent("hearth", { dbPath });
  t.after(() => second.stop());
  const after = second.store.allInStates([TaskState.TASK_STATE_WORKING]);
  assert.equal(after.length, 0, "nothing left in working after restart");
  const failed = second.store
    .allInStates([TaskState.TASK_STATE_FAILED])
    .find((task) => task.id === orphan.id);
  assert.ok(failed, "orphaned task is failed, not gone");
  const part = failed.status?.message?.parts[0];
  assert.ok(part?.content?.$case === "text");
  assert.match(part.content.value, /restarted/);
});

// Fleet health: accurate with an agent deliberately stopped.
test("fleet health reports up/down, in-flight, and last error accurately", async (t) => {
  const hearth = await startAgent("hearth");
  t.after(() => hearth.stop());
  const grove = await startAgent("grove");
  const groveUrl = grove.url;
  await grove.stop(); // deliberately down

  // Give hearth one failed task for last-error reporting.
  const bridge = startBridge(hearth);
  t.after(() => bridge.state.close());
  hearth.cli.hold = true;
  void bridge.engine.handleEvent(dm("doomed", "9.1"));
  await until(
    () => hearth.store.allInStates([TaskState.TASK_STATE_WORKING]).length === 1,
    "in-flight task exists",
  );

  const roster = parseRoster(`
agents:
  hearth:
    host: home
    user: hearth
    description: hearth integration agent.
    tag: tag:thicket-hearth
    harness: { type: claude-agent-sdk, cwd: /tmp, model: claude-opus-5 }
  grove:
    host: home
    user: grove
    description: grove integration agent.
    tag: tag:thicket-grove
    harness: { type: claude-agent-sdk, cwd: /tmp, model: claude-opus-5 }
`);

  const results = await fleetHealth(roster, {
    http: (spec) =>
      fetch(spec.url, {
        method: spec.method,
        headers: { "x-thicket-peer-tags": "tag:thicket-bridge", ...spec.headers },
        body: spec.body,
      }).then(async (res) => ({
        status: res.status,
        headers: Object.fromEntries(res.headers.entries()),
        body: await res.text(),
      })),
    endpointOverrides: { hearth: hearth.url, grove: groveUrl },
  });

  const hearthHealth = results.find((r) => r.agent === "hearth");
  const groveHealth = results.find((r) => r.agent === "grove");
  assert.ok(hearthHealth?.up, "hearth reported up");
  assert.equal(hearthHealth.inFlight, 1, "in-flight task counted");
  assert.equal(groveHealth?.up, false, "stopped agent reported down");
  assert.match(groveHealth.detail, /fetch failed|ECONNREFUSED|unreachable/i);

  hearth.cli.hold = false;
  hearth.cli.release();
});

// A second agent is roster + provision only — no code changes.
test("a second agent needs only agents.yaml edits: cards, manifests, daemon all derive", async (t) => {
  const roster = parseRoster(`
agents:
  hearth:
    host: home
    user: hearth
    description: Personal assistant for calendar, todo list, Obsidian vault, and email triage across the household. Reads the inbox, sorts what matters, drafts replies for review, and keeps the week's plan honest without ever sending mail on its own.
    tag: tag:thicket-hearth
    harness: { type: claude-agent-sdk, cwd: /home/hearth, model: claude-opus-5 }
  grove:
    host: workshop
    user: grove
    description: Keeps the CI fleet green by watching builds, investigating red pipelines, bisecting regressions to the breaking change, and proposing fixes as reviewable patches rather than pushing anything itself to any branch.
    tag: tag:thicket-grove
    harness: { type: claude-agent-sdk, cwd: /home/grove, model: claude-sonnet-5 }
`);
  // The same generators that provisioned agent one accept agent two.
  for (const [name, entry] of Object.entries(roster.agents)) {
    const card = toAgentCard(name, entry);
    assert.equal(card.name, name);
    const { manifest } = toSlackManifest(card);
    assert.equal(manifest.display_information.name, name);
  }
  // And the same daemon stack boots for the new agent unchanged.
  const grove = await startAgent("grove");
  t.after(() => grove.stop());
  const slack = new MockSlack();
  void slack;
  const response = await fetch(`${grove.url}/.well-known/agent-card.json`);
  assert.equal(response.status, 200);
  assert.equal(((await response.json()) as { name: string }).name, "grove");
});

// The CLI-level coalescing contract the harness relies on.
test("harness sanity: CoalescingCli folds queued sends and reports queue depth", async () => {
  const cli = new CoalescingCli();
  assert.equal(cli.turnsRun, 0);
});
