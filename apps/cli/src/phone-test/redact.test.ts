import test from "node:test";
import assert from "node:assert/strict";

import { redactRecordings } from "./redact.js";

const HOST = "ivys-example.tailXXXX.ts.net".replace("XXXX", "abcd");

test("identifiers are replaced with stable stand-ins, keys included", () => {
  const call = "CA" + "a".repeat(32);
  const lines = [
    JSON.stringify({ ms: 2, dir: "in", frame: { callSid: call, from: "+15551234567" } }),
    JSON.stringify({ ms: 1, dir: "ws", signatureMatched: { [`wss://${HOST}/operator/relay/${"f".repeat(24)}`]: true } }),
  ];
  const out = redactRecordings([lines.join("\n")]);
  assert.equal(out.length, 2);
  // Ordered by ms, not input order.
  assert.match(out[0]!, /phone\.example\.net\/operator\/relay\/fixture/);
  assert.ok(!out.join("").includes(HOST));
  assert.match(out[1]!, /CA0{31}1/);
  assert.match(out[1]!, /\+15550100001/);
  assert.ok(!out.join("").includes(call));
});

test("two files merge into one timeline and share the stand-in numbering", () => {
  const a = JSON.stringify({ ms: 5, sid: "CA" + "b".repeat(32) });
  const b = JSON.stringify({ ms: 3, sid: "CA" + "c".repeat(32) });
  const out = redactRecordings([a, b]);
  assert.match(out[0]!, /CA0{31}2/); // ms 3, but numbered second: order given, not order played
  assert.match(out[1]!, /CA0{31}1/);
});

test("tokens and forwarding headers are scrubbed outright", () => {
  const out = redactRecordings([
    JSON.stringify({ ms: 1, form: { CallToken: "secret", CallerCity: "SPOKANE" }, headers: { "x-forwarded-for": "9.9.9.9" } }),
  ]);
  assert.match(out[0]!, /"CallToken":"<redacted>"/);
  assert.match(out[0]!, /"CallerCity":""/);
  assert.match(out[0]!, /203\.0\.113\.1/);
  assert.ok(!out[0]!.includes("9.9.9.9"));
});
