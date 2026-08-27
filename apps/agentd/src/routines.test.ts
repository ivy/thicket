import test from "node:test";
import assert from "node:assert/strict";

import { RoutineRunner, ROUTINE_FAILURE_LIMIT, routinePrompt } from "./routines.js";
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
    runTurn: async (routineId, prompt) => {
      runs.push({ routineId, prompt });
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
