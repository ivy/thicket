import test from "node:test";
import assert from "node:assert/strict";

import {
  ONE_SHOT_RETRY_LIMIT,
  RoutineRunner,
  ROUTINE_FAILURE_LIMIT,
  oneShotPrompt,
  routinePrompt,
} from "./routines.js";
import { RoutineStore } from "./store/routines.js";

interface Run {
  routineId: string;
  prompt: string;
}

function harness(turnState: () => { state: string; error?: string }) {
  const store = new RoutineStore(":memory:");
  const runs: Run[] = [];
  const warnings: string[] = [];
  let clock = new Date("2026-08-27T09:00:10");
  const runner = new RoutineRunner({
    store,
    runTurn: async (routine, prompt) => {
      runs.push({ routineId: routine.id, prompt });
      return turnState();
    },
    logger: {
      info: () => {},
      warn: (msg: string) => warnings.push(msg),
      error: () => {},
    } as never,
    now: () => clock,
  });
  return {
    store,
    runs,
    warnings,
    runner,
    setClock(iso: string) {
      clock = new Date(iso);
    },
  };
}

test("a due routine fires once per matching minute, and misses are skipped", async () => {
  const h = harness(() => ({ state: "completed" }));
  const routine = h.store.create({ name: "morning", cron: "0 9 * * *", prompt: "check things" });

  await h.runner.tick();
  await h.runner.tick(); // same minute again: no second fire
  assert.equal(h.runs.length, 1);
  assert.match(h.runs[0]!.prompt, /Scheduled routine "morning"/);
  assert.match(h.runs[0]!.prompt, /Silence is the expected outcome/);
  assert.match(h.runs[0]!.prompt, /check things/);

  h.setClock("2026-08-27T09:05:00"); // woke up late: 09:00 has passed
  await h.runner.tick();
  assert.equal(h.runs.length, 1, "a missed minute is skipped, not replayed");

  assert.equal(h.store.get(routine.id)?.lastOutcome, "completed");
  h.store.close();
});

test("a disabled routine never fires", async () => {
  const h = harness(() => ({ state: "completed" }));
  const routine = h.store.create({ name: "paused", cron: "* * * * *", prompt: "x" });
  h.store.update(routine.id, { enabled: false });
  await h.runner.tick();
  assert.equal(h.runs.length, 0);
  h.store.close();
});

test("five consecutive failures disable the routine and report exactly once", async () => {
  const h = harness(() => ({ state: "failed", error: "boom" }));
  const routine = h.store.create({ name: "flaky", cron: "* * * * *", prompt: "x" });

  for (let minute = 0; minute < ROUTINE_FAILURE_LIMIT; minute += 1) {
    h.setClock(`2026-08-27T09:0${minute}:00`);
    await h.runner.tick();
  }

  const after = h.store.get(routine.id);
  assert.equal(after?.enabled, false, "disabled at the limit");
  assert.equal(after?.consecutiveFailures, ROUTINE_FAILURE_LIMIT);
  // limit runs + one disablement report
  assert.equal(h.runs.length, ROUTINE_FAILURE_LIMIT + 1);
  assert.match(h.runs.at(-1)!.prompt, /has been disabled/);
  assert.match(h.runs.at(-1)!.prompt, /boom/);

  // And it stays quiet afterwards.
  h.setClock("2026-08-27T09:30:00");
  await h.runner.tick();
  assert.equal(h.runs.length, ROUTINE_FAILURE_LIMIT + 1);
  h.store.close();
});

test("a success resets the failure count", async () => {
  let fail = true;
  const h = harness(() => (fail ? { state: "failed", error: "x" } : { state: "completed" }));
  const routine = h.store.create({ name: "wobbly", cron: "* * * * *", prompt: "x" });

  h.setClock("2026-08-27T09:01:00");
  await h.runner.tick();
  h.setClock("2026-08-27T09:02:00");
  await h.runner.tick();
  assert.equal(h.store.get(routine.id)?.consecutiveFailures, 2);

  fail = false;
  h.setClock("2026-08-27T09:03:00");
  await h.runner.tick();
  assert.equal(h.store.get(routine.id)?.consecutiveFailures, 0);
  assert.equal(h.store.get(routine.id)?.enabled, true);
  h.store.close();
});

test("routine CRUD round-trips and survives reopening the store", () => {
  const store = new RoutineStore(":memory:");
  const created = store.create({ name: "a", cron: "0 9 * * *", prompt: "p" });
  assert.equal(store.list().length, 1);
  assert.equal(store.update(created.id, { cron: "30 8 * * 1-5", name: "b" }), true);
  assert.equal(store.get(created.id)?.cron, "30 8 * * 1-5");
  assert.equal(store.get(created.id)?.name, "b");
  assert.equal(store.update("nope", { name: "x" }), false);
  assert.equal(store.remove(created.id), true);
  assert.equal(store.remove(created.id), false);
  assert.equal(store.list().length, 0);
  store.close();
});

test("re-enabling resets the failure counter", () => {
  const store = new RoutineStore(":memory:");
  const created = store.create({ name: "a", cron: "* * * * *", prompt: "p" });
  store.recordRun(created.id, "failed", true);
  store.recordRun(created.id, "failed", true);
  store.disable(created.id);
  store.update(created.id, { enabled: true });
  assert.equal(store.get(created.id)?.consecutiveFailures, 0);
  assert.equal(store.get(created.id)?.enabled, true);
  store.close();
});

test("the run prompt says the reply goes nowhere and names the tools", () => {
  const prompt = routinePrompt({ name: "n", prompt: "do the thing" }, new Date(0));
  assert.match(prompt, /reply text goes nowhere/);
  assert.match(prompt, /thicket Slack tools/);
  assert.match(prompt, /do the thing$/);
});

// ---------------------------------------------------------------- one-shots

const ORIGIN = { channel: "D1", threadTs: "1724650000.000100", contextId: "ctx-origin" };

test("a one-shot fires once its time has come, catches up when late, and never fires again", async () => {
  const h = harness(() => ({ state: "completed" }));
  const shot = h.store.createOneShot({
    name: "ping",
    atMs: new Date("2026-08-27T09:05:00").getTime(),
    prompt: "post the word ping",
    origin: ORIGIN,
  });

  await h.runner.tick(); // 09:00:10 — not yet
  assert.equal(h.runs.length, 0);

  h.setClock("2026-08-27T09:47:00"); // slept through 09:05: late beats never
  await h.runner.tick();
  assert.equal(h.runs.length, 1);
  assert.equal(h.runs[0]!.routineId, shot.id);
  assert.match(h.runs[0]!.prompt, /Scheduled reminder "ping"/);
  assert.match(h.runs[0]!.prompt, /channel D1, thread 1724650000.000100/);
  assert.match(h.runs[0]!.prompt, /post the word ping/);

  const after = h.store.get(shot.id);
  assert.equal(after?.firedMs, new Date("2026-08-27T09:47:00").getTime());
  assert.equal(after?.lastOutcome, "completed");

  h.setClock("2026-08-27T10:00:00");
  await h.runner.tick();
  await h.runner.tick();
  assert.equal(h.runs.length, 1, "spent: never again");
  h.store.close();
});

test("a failing one-shot is retried once, then given up on and reported to its origin", async () => {
  const h = harness(() => ({ state: "failed", error: "bridge unreachable" }));
  const shot = h.store.createOneShot({
    name: "check",
    atMs: new Date("2026-08-27T08:00:00").getTime(),
    prompt: "check the build",
    origin: ORIGIN,
  });

  await h.runner.tick(); // first try fails; still due
  assert.equal(h.runs.length, 1);
  assert.equal(h.store.get(shot.id)?.firedMs, null, "a failed run leaves it due for a retry");

  await h.runner.tick(); // the retry fails: spent, and reported
  assert.equal(h.runs.length, ONE_SHOT_RETRY_LIMIT + 1 + 1, "attempts plus one report");
  const report = h.runs.at(-1)!;
  assert.equal(report.routineId, shot.id);
  assert.match(report.prompt, /could not be carried out/);
  assert.match(report.prompt, /bridge unreachable/);
  assert.match(report.prompt, /channel D1, thread 1724650000.000100/);
  assert.notEqual(h.store.get(shot.id)?.firedMs, null, "given up: spent");

  await h.runner.tick();
  assert.equal(h.runs.length, 3, "and stays quiet");
  h.store.close();
});

test("deleting an unfired one-shot cancels it; a disabled one waits", async () => {
  const h = harness(() => ({ state: "completed" }));
  const due = new Date("2026-08-27T08:00:00").getTime();
  const gone = h.store.createOneShot({ name: "a", atMs: due, prompt: "p", origin: ORIGIN });
  const paused = h.store.createOneShot({ name: "b", atMs: due, prompt: "p", origin: ORIGIN });
  assert.equal(h.store.remove(gone.id), true);
  h.store.update(paused.id, { enabled: false });
  await h.runner.tick();
  assert.equal(h.runs.length, 0);
  h.store.close();
});

test("one-shot rows round-trip with their origin, sit beside cron rows, and prune once spent", () => {
  const store = new RoutineStore(":memory:");
  const cron = store.create({ name: "morning", cron: "0 9 * * *", prompt: "p" });
  const shot = store.createOneShot({ name: "once", atMs: 1_000, prompt: "q", origin: ORIGIN });
  assert.deepEqual(
    store.list().map((r) => [r.id, r.kind]),
    [
      [cron.id, "cron"],
      [shot.id, "at"],
    ],
  );
  const got = store.get(shot.id)!;
  assert.equal(got.atMs, 1_000);
  assert.deepEqual(got.origin, ORIGIN);
  assert.equal(got.cron, "");
  assert.equal(store.get(cron.id)?.origin, null);
  // A one-shot keeps no cron, whatever an update says.
  store.update(shot.id, { cron: "* * * * *", name: "renamed" });
  assert.equal(store.get(shot.id)?.cron, "");
  assert.equal(store.get(shot.id)?.name, "renamed");
  // Unfired rows are never pruned; spent ones go with the journal's retention.
  assert.equal(store.pruneFired(0, 10_000), 0);
  store.markFired(shot.id, 5_000);
  assert.equal(store.pruneFired(10_000, 10_000), 0, "younger than the retention");
  assert.equal(store.pruneFired(1_000, 10_000), 1);
  assert.equal(store.list().length, 1, "the cron routine stays");
  store.close();
});

test("the one-shot prompt says where the answer belongs and that someone is waiting", () => {
  const prompt = oneShotPrompt({ name: "n", prompt: "do it", origin: ORIGIN }, new Date(0));
  assert.match(prompt, /reply text goes nowhere/);
  assert.match(prompt, /post_message \(channel D1, thread 1724650000.000100\)/);
  assert.match(prompt, /say something/);
  assert.match(prompt, /do it$/);
});
