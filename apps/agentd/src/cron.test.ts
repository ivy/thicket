import test from "node:test";
import assert from "node:assert/strict";

import { cronMatches, parseCron } from "./cron.js";

function at(spec: string, iso: string): boolean {
  const parsed = parseCron(spec);
  assert.ok(parsed, `should parse: ${spec}`);
  return cronMatches(parsed, new Date(iso));
}

// 2026-08-27 is a Thursday (dow 4); times below are local.

test("wildcards, exact values, ranges, lists, and steps all match as cron does", () => {
  assert.equal(at("* * * * *", "2026-08-27T09:30:00"), true);
  assert.equal(at("0 9 * * *", "2026-08-27T09:00:00"), true);
  assert.equal(at("0 9 * * *", "2026-08-27T09:01:00"), false);
  assert.equal(at("0 9 * * 1-5", "2026-08-27T09:00:00"), true, "Thursday is a weekday");
  assert.equal(at("0 9 * * 6,0", "2026-08-27T09:00:00"), false, "and not the weekend");
  assert.equal(at("*/15 * * * *", "2026-08-27T09:45:00"), true);
  assert.equal(at("*/15 * * * *", "2026-08-27T09:50:00"), false);
  assert.equal(at("30 8-17/3 * * *", "2026-08-27T14:30:00"), true, "8,11,14,17");
  assert.equal(at("0 0 27 8 *", "2026-08-27T00:00:00"), true);
  assert.equal(at("0 0 * * 7", "2026-08-30T00:00:00"), true, "7 means Sunday");
});

test("restricted dom OR restricted dow fires on either, per standard cron", () => {
  // The 27th is a Thursday; dow says Monday, dom says 27 — either matches.
  assert.equal(at("0 9 27 * 1", "2026-08-27T09:00:00"), true);
  // Neither the day nor the weekday: no fire.
  assert.equal(at("0 9 28 * 1", "2026-08-27T09:00:00"), false);
});

test("junk is rejected rather than half-parsed", () => {
  for (const bad of [
    "",
    "* * * *",
    "* * * * * *",
    "60 * * * *",
    "* 24 * * *",
    "a * * * *",
    "1-0 * * * *",
    "*/0 * * * *",
    "1//2 * * * *",
    "@daily",
  ]) {
    assert.equal(parseCron(bad), undefined, `should reject: ${JSON.stringify(bad)}`);
  }
});
