import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CallRegistry } from "./registry.js";

test("a call is recorded once, attached to its session, and ended with the first reason only", () => {
  const registry = new CallRegistry(":memory:");
  const call = { callSid: "CA1", from: "+15550100001", to: "+15550100002", direction: "inbound", startedMs: 1000 };
  registry.recordCall(call);
  registry.recordCall({ ...call, startedMs: 2000 });
  assert.equal(registry.call("CA1")?.startedMs, 1000, "the voice webhook and setup both record; the first wins");
  assert.deepEqual(registry.openCalls().map((c) => c.callSid), ["CA1"]);

  registry.attachSession("CA1", "hearth", "ctx-1");
  assert.equal(registry.call("CA1")?.agent, "hearth");
  assert.equal(registry.call("CA1")?.contextId, "ctx-1");

  assert.ok(registry.endCall("CA1", 5000, "goodbye"));
  assert.ok(!registry.endCall("CA1", 6000, "call:completed"), "a later status callback does not overwrite");
  assert.deepEqual(registry.call("CA1"), { ...call, agent: "hearth", contextId: "ctx-1", endedMs: 5000, endReason: "goodbye" });
  assert.deepEqual(registry.openCalls(), []);
  assert.equal(registry.call("CA-none"), undefined);
});

test("sessions round-trip through the state port, and the file is owner-only", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "phone-registry-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "phone.db");
  const registry = new CallRegistry(path);
  assert.equal(statSync(path).mode & 0o777, 0o600);

  assert.equal(registry.sessionFor("hearth"), undefined);
  registry.saveSession({ agent: "hearth", contextId: "ctx-1", openedByCall: "CA1", lastActiveAt: 1000 });
  registry.saveSession({ agent: "hearth", contextId: "ctx-1", openedByCall: "CA1", lastActiveAt: 2000, openTaskId: "t9" });
  assert.deepEqual(registry.sessionFor("hearth"), { agent: "hearth", contextId: "ctx-1", openedByCall: "CA1", lastActiveAt: 2000, openTaskId: "t9" });
  registry.close();

  // A second process on the same file sees the same rows.
  const again = new CallRegistry(path);
  assert.equal(again.sessionFor("hearth")?.openTaskId, "t9");
  again.close();
});

test("failed calls within the window lock the number for the cooldown, then it clears", () => {
  const registry = new CallRegistry(":memory:");
  const policy = { failedCalls: 3, windowSeconds: 3600, cooldownSeconds: 1800 };
  const t0 = Date.parse("2026-08-30T10:00:00Z");
  const number = "+15550100001";
  assert.equal(registry.lockedUntil(number, t0), undefined);
  assert.equal(registry.recordFailedCall(number, t0, policy), undefined);
  assert.equal(registry.recordFailedCall(number, t0 + 60_000, policy), undefined);
  assert.equal(registry.lockedUntil(number, t0 + 60_000), undefined, "two failures are not a lockout");
  const until = registry.recordFailedCall(number, t0 + 120_000, policy);
  assert.equal(until, t0 + 120_000 + 1_800_000, "the third locks for the cooldown");
  assert.equal(registry.lockedUntil(number, t0 + 120_000), until);
  assert.equal(registry.lockedUntil(number, until! + 1), undefined, "and it clears when the cooldown ends");
  assert.equal(registry.lockedUntil("+15550100009", t0 + 120_000), undefined, "other numbers are untouched");

  // Failures older than the window do not count.
  const later = until! + 10_000;
  assert.equal(registry.recordFailedCall(number, later, policy), undefined);
  assert.equal(registry.recordFailedCall(number, later + 3_700_000, policy), undefined, "the first has aged out");
  assert.equal(registry.recordFailedCall(number, later + 3_710_000, policy), undefined);
  assert.notEqual(registry.recordFailedCall(number, later + 3_720_000, policy), undefined, "three within an hour lock again");
});
