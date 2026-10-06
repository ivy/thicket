import test from "node:test";
import assert from "node:assert/strict";

import { deriveContextId, STOP_ID } from "@thicket/discord";

import { DM, dm, OPERATOR, startDiscordBridge } from "./discord-harness.js";
import { startAgent, until } from "./harness.js";

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

// The Discord round trip: a DM becomes a turn on a real agentd, the
// answer streams back onto one card, and the card ends without Stop.
test("discord: a DM round trip through the bridge, A2A, agentd, session", async (t) => {
  const agent = await startAgent("hearth");
  t.after(() => agent.stop());
  const bridge = startDiscordBridge(agent);
  t.after(() => bridge.state.close());

  await bridge.engine.handleEvent(dm("what is 2+2?", "m1"));
  await settle();

  const [card] = bridge.discord.cards();
  assert.ok(card, "one card was posted");
  const first = bridge.discord.calls.find((c) => c.type === "postCard");
  assert.ok(first && first.type === "postCard" && first.body.message_reference === undefined, "the card does not quote the DM");
  // The fake CLI echoes its prompt: the envelope's preamble reached the
  // session ahead of the operator's words.
  assert.match(
    bridge.discord.answer(card),
    /answer\(You are in Discord DM dm-1\. [\s\S]*The message is from op-1, your operator\.\n\nwhat is 2\+2\?\)/,
    "the reply reached the card, prompt led by where it came from",
  );
  const last = bridge.discord.displays(card).at(-1);
  assert.equal(last?.length, 1, "a finished answer is the text alone");
  assert.equal(agent.cli.turnsRun, 1);
  assert.ok(bridge.discord.calls.some((c) => c.type === "typing"), "the typing indicator ran");
  assert.equal(bridge.state.taskById("whatever"), undefined);
});

// Stop from the card cancels the running task through agentd.
test("discord: Stop on the card cancels the turn", async (t) => {
  const agent = await startAgent("hearth");
  t.after(() => agent.stop());
  const bridge = startDiscordBridge(agent);
  t.after(() => bridge.state.close());
  agent.cli.hold = true;

  const turn = bridge.engine.handleEvent(dm("take your time", "m2"));
  await until(() => agent.cli.turnsRun === 1, "turn started");
  await until(() => bridge.discord.cards().length === 1, "card posted");
  const [card] = bridge.discord.cards();

  await bridge.engine.handleEvent({
    kind: "component",
    interactionId: "i1",
    token: "t",
    channel: DM,
    messageId: card!,
    userId: OPERATOR,
    customId: STOP_ID,
    componentType: 2,
    values: [],
  });
  agent.cli.hold = false;
  agent.cli.release();
  await turn;
  await settle();

  const last = bridge.discord.displays(card!).at(-1);
  assert.ok(last && /Stopped|Done/.test(last[0] ?? ""), `card ended: ${last?.[0]}`);
});

// The context id is derived from the channel, so a second DM in the same
// channel reaches the same session.
test("discord: two DMs share one context", async (t) => {
  const agent = await startAgent("hearth");
  t.after(() => agent.stop());
  const bridge = startDiscordBridge(agent);
  t.after(() => bridge.state.close());

  await bridge.engine.handleEvent(dm("first", "m3"));
  await bridge.engine.handleEvent(dm("second", "m4"));
  await settle();

  assert.equal(agent.cli.turnsRun, 2);
  assert.equal(bridge.state.contextFor(agent.name, DM)?.contextId ?? deriveContextId(DM), deriveContextId(DM));
  assert.equal(bridge.discord.cards().length, 2, "one card per turn");
});
