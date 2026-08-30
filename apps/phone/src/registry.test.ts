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
