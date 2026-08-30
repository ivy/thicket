import test from "node:test";
import assert from "node:assert/strict";

import type { AwaitedUtterance, CallerLegPort, LegStatus, TranscriptEntry } from "./leg.js";
import { authAndConnect, expectAnyWords, expectWords, SCENARIOS, ScenarioFailure, type ScenarioContext } from "./scenarios.js";
import { notThePin } from "./runner.js";

/**
 * A scripted leg: hearings play from a queue, the call "ends" when the
 * queue is drained. Enough to prove the choreography and the failure
 * messages; the wire itself is what `thicket phone-test run` is for.
 */
class FakeLeg implements CallerLegPort {
  said: string[] = [];
  keyed: string[] = [];
  private up = false;
  constructor(private readonly hearings: string[]) {}

  place(): Promise<{ callSid: string; attempts: number }> {
    this.up = true;
    return Promise.resolve({ callSid: "CAfake0001", attempts: 1 });
  }
  say(text: string): Promise<{ playbackObserved: boolean }> {
    this.said.push(text);
    return Promise.resolve({ playbackObserved: true });
  }
  press(digits: string): Promise<void> {
    this.keyed.push("#".repeat(digits.length));
    return Promise.resolve();
  }
  enterPin(): Promise<void> {
    return this.press("12345678");
  }
  awaitReply(): Promise<AwaitedUtterance> {
    const next = this.hearings.shift();
    if (next === undefined) {
      this.up = false;
      return Promise.reject(new Error("nothing heard in time"));
    }
    if (this.hearings.length === 0) {
      this.up = false;
    }
    return Promise.resolve({ text: next, atMs: 0, sinceSaidMs: 100 });
  }
  transcript(): TranscriptEntry[] {
    return [];
  }
  status(): LegStatus {
    return {
      call: this.up ? { callSid: "CAfake0001", sinceSetupMs: 0 } : null,
      farSpeaking: this.hearings.length > 0,
      selfSpeaking: false,
      heardPending: this.hearings.length,
    };
  }
  hangup(): Promise<void> {
    this.up = false;
    return Promise.resolve();
  }
}

function contextFor(leg: FakeLeg): ScenarioContext {
  return { leg, agentName: "Hearth", wrongPin: "00000000", log: () => undefined };
}

function scenario(name: string) {
  const found = SCENARIOS.find((s) => s.name === name);
  assert.ok(found, `no scenario ${name}`);
  return found;
}

test("word assertions name what was heard instead", () => {
  expectWords("Shall I connect you to hearth?", ["connect"]);
  assert.throws(() => expectWords("static noise", ["connect"]), /heard instead: "static noise"/);
  expectAnyWords("Twenty three.", [["23"], ["twenty three"]]);
  assert.throws(() => expectAnyWords("Four.", [["seven"], ["7"]]), ScenarioFailure);
});

test("authAndConnect steers past the near-miss and the resume offer", async () => {
  const leg = new FakeLeg([
    "Iva. Shall I connect you to hearth?",
    "Did you say hearth?",
    "You were talking to Hearth two minutes ago. Resume or start fresh.",
    "Connected to Hearth.",
    "sentinel",
  ]);
  await authAndConnect(contextFor(leg));
  assert.deepEqual(leg.said, ["Hearth", "Yes", "Start fresh"]);
});

test("dial-string-pin passes on the hello and fails naming the noise", async () => {
  await scenario("dial-string-pin").run(contextFor(new FakeLeg(["Shall I connect you to hearth?"])));
  await assert.rejects(
    scenario("dial-string-pin").run(contextFor(new FakeLeg(["unrelated words"]))),
    /expected to hear "connect"; heard instead: "unrelated words"/,
  );
});

test("wrong-pin wants two refusals and a goodbye, and masks what it keys", async () => {
  const leg = new FakeLeg(["That's not it. Try again.", "That's not it. Try again.", "That's not it. Goodbye."]);
  await scenario("wrong-pin").run(contextFor(leg));
  assert.deepEqual(leg.keyed, ["########", "########", "########"]);
  await assert.rejects(
    scenario("wrong-pin").run(contextFor(new FakeLeg(["Hi. It's Aiva.", "x", "y"]))),
    ScenarioFailure,
  );
});

test("pick-and-ask checks the arithmetic came back", async () => {
  const leg = new FakeLeg([
    "Shall I connect you to hearth?",
    "Connected to Hearth.",
    "Twenty three.",
    "Goodbye.",
  ]);
  await scenario("pick-and-ask").run(contextFor(leg));
  assert.ok(leg.said.some((text) => text.includes("nineteen plus four")));
});

test("unlisted-caller is skipped without a second identity", () => {
  const skip = scenario("unlisted-caller").skip?.(contextFor(new FakeLeg([])));
  assert.match(skip ?? "", /second caller identity/);
});

test("the wrong-pin digits differ from the PIN in every position", () => {
  assert.equal(notThePin("31415926"), "42526037");
  assert.equal(notThePin("99999999"), "00000000");
  for (const pin of ["00000000", "31415926"]) {
    const wrong = notThePin(pin);
    assert.equal(wrong.length, 8);
    assert.ok([...wrong].every((digit, index) => digit !== pin[index]));
  }
});
