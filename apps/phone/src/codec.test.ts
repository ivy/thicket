import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

import { decodeInbound, encodeOutbound, endSession, playDigits, RelayCodecError, say, type CallEvent, type RelayCommand } from "./codec.js";

const FIXTURES = new URL("../../../tests/fixtures/conversationrelay/", import.meta.url);

/** Every frame Twilio sent during one recorded call, as the codec sees it. */
export function fixtureEvents(name: string): CallEvent[] {
  const lines = readFileSync(new URL(`${name}.jsonl`, FIXTURES), "utf8").split("\n");
  const events: CallEvent[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const entry = JSON.parse(line) as { dir: string; frame?: unknown };
    if (entry.dir === "in" && entry.frame !== undefined) {
      events.push(decodeInbound(JSON.stringify(entry.frame)));
    }
  }
  return events;
}

test("every frame in every recorded call decodes", () => {
  const files = readdirSync(FIXTURES).filter((f) => f.endsWith(".jsonl"));
  assert.ok(files.length >= 15, `expected the spike's recordings, found ${files.length}`);
  const kinds = new Set<string>();
  for (const file of files) {
    const events = fixtureEvents(file.replace(/\.jsonl$/, ""));
    assert.equal(events[0]?.kind, "setup", `${file} starts with setup`);
    for (const e of events) kinds.add(e.kind);
  }
  assert.deepEqual(
    [...kinds].sort(),
    ["interrupt", "key", "played", "relay-error", "setup", "speaking", "speech"],
  );
});

test("the shapes that matter come through with their meaning", () => {
  const pin = fixtureEvents("dial-string-pin");
  assert.equal(
    pin.filter((e) => e.kind === "key").map((e) => (e.kind === "key" ? e.digit : "")).join(""),
    "47290138#",
  );
  const setup = pin[0];
  assert.ok(setup?.kind === "setup" && setup.callSid.startsWith("CA") && setup.callStatus === "RINGING");

  const interrupt = fixtureEvents("interrupt").find((e) => e.kind === "interrupt");
  assert.deepEqual(interrupt, { kind: "interrupt", heard: "Sentence 2 of", afterMs: 684 });

  const spoken = fixtureEvents("pin-spoken").filter((e) => e.kind === "speech");
  assert.equal(spoken.filter((e) => e.kind === "speech" && e.final).length, 2, "two finalized prompts");
  assert.ok(spoken.length > 10, "and a stream of partials before each");

  const errors = fixtureEvents("malformed-frames").filter((e) => e.kind === "relay-error");
  assert.equal(errors.length, 10);
});

test("unknown or broken frames are refused, naming what came", () => {
  assert.throws(() => decodeInbound("not json"), RelayCodecError);
  assert.throws(
    () => decodeInbound(JSON.stringify({ type: "hologram", x: 1 })),
    (err: unknown) => err instanceof RelayCodecError && /type hologram/.test(err.message),
  );
  assert.throws(() => decodeInbound(JSON.stringify({ type: "prompt", voicePrompt: "hi" })), RelayCodecError);
});

test("outbound commands are validated before they are encoded", () => {
  assert.equal(encodeOutbound(say("Hello.", true)), JSON.stringify({ type: "text", token: "Hello.", last: true }));
  assert.equal(encodeOutbound(endSession("goodbye")), JSON.stringify({ type: "end", handoffData: "goodbye" }));
  assert.equal(encodeOutbound(playDigits("1234#")), JSON.stringify({ type: "sendDigits", digits: "1234#" }));
  assert.throws(
    () => encodeOutbound(playDigits("12A")),
    (err: unknown) => err instanceof RelayCodecError && /digits are 0-9, w, #, \* only/.test(err.message),
  );
  assert.throws(() => encodeOutbound({ type: "language" } as RelayCommand), RelayCodecError);
  assert.throws(() => encodeOutbound({ type: "text", token: "x", last: "yes" } as unknown as RelayCommand), RelayCodecError);
  assert.throws(() => encodeOutbound({ type: "text", token: "x", last: true, extra: 1 } as unknown as RelayCommand), RelayCodecError);
});
