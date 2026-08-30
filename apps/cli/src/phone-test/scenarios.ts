import type { CallerLegPort } from "./leg.js";

/**
 * The phone's live regression suite (#52): one scenario per behaviour,
 * scripted over the caller leg's verbs, asserted on what was actually
 * heard. Transcripts are Flux's hearing of a TTS voice, so assertions
 * match distinctive words — never sentences — and tolerate the clipped
 * first utterance the synthetic leg has (#50: it attaches ~1.5 s after
 * answer, where a human ear is live from the start).
 */

export class ScenarioFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScenarioFailure";
  }
}

export interface ScenarioContext {
  leg: CallerLegPort;
  /** The agent the picker is asked for; the rig's is Hearth. */
  agentName: string;
  /** Eight digits that are certainly not the PIN. */
  wrongPin: string;
  /** A caller id the bridge does not allow-list, when the operator has one. */
  unlistedFrom?: string;
  log(line: string): void;
}

export interface Scenario {
  name: string;
  proves: string;
  /** A reason to skip, or undefined to run. */
  skip?(context: ScenarioContext): string | undefined;
  run(context: ScenarioContext): Promise<void>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Every listed word (case-insensitive) must be in what was heard. */
export function expectWords(heard: string, words: string[]): void {
  const lower = heard.toLowerCase();
  const missing = words.filter((word) => !lower.includes(word.toLowerCase()));
  if (missing.length > 0) {
    throw new ScenarioFailure(`expected to hear ${words.map((w) => `"${w}"`).join(" + ")}; heard instead: "${heard}"`);
  }
}

/** At least one alternative's words must all be present. */
export function expectAnyWords(heard: string, alternatives: string[][]): void {
  const lower = heard.toLowerCase();
  const hit = alternatives.some((words) => words.every((word) => lower.includes(word.toLowerCase())));
  if (!hit) {
    throw new ScenarioFailure(
      `expected to hear one of ${alternatives.map((words) => words.join("+")).join(" | ")}; heard instead: "${heard}"`,
    );
  }
}

/**
 * Scan forward until an utterance carries the expected words: Flux can
 * fragment one spoken sentence into several finals, and a slow task's
 * leftovers can land between a say and its reply, so the words may not be
 * in the very next utterance.
 */
async function awaitUntilWords(
  leg: CallerLegPort,
  alternatives: string[][],
  opts: { utterances?: number; timeoutMs?: number } = {},
): Promise<string> {
  const cap = opts.utterances ?? 4;
  const wanted = alternatives.map((words) => words.join("+")).join(" | ");
  let last = "";
  for (let i = 0; i < cap; i++) {
    try {
      last = (await leg.awaitReply({ timeoutMs: opts.timeoutMs ?? 45_000 })).text;
    } catch (err) {
      throw new ScenarioFailure(
        `expected to hear ${wanted}; ${last === "" ? "nothing was heard" : `last heard: "${last}"`} ` +
          `(${err instanceof Error ? err.message : String(err)})`,
      );
    }
    const lower = last.toLowerCase();
    if (alternatives.some((words) => words.every((word) => lower.includes(word.toLowerCase())))) {
      return last;
    }
  }
  throw new ScenarioFailure(`expected to hear ${wanted} within ${cap} utterances; last heard: "${last}"`);
}

async function untilEnded(leg: CallerLegPort, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (leg.status().call !== null) {
    if (Date.now() >= deadline) {
      throw new ScenarioFailure(`the call did not end within ${timeoutMs} ms`);
    }
    await sleep(250);
  }
}

/** Swallow queued utterances until the line goes quiet. */
async function drain(leg: CallerLegPort): Promise<void> {
  for (;;) {
    try {
      await leg.awaitReply({ timeoutMs: 3_500 });
    } catch {
      return;
    }
  }
}

/** Dial with the post-dial PIN and steer the picker until connected. */
export async function authAndConnect(context: ScenarioContext): Promise<void> {
  const { leg, agentName } = context;
  await leg.place({});
  const hello = await leg.awaitReply({});
  expectWords(hello.text, ["connect"]);
  await leg.say(agentName);
  for (let i = 0; i < 6; i++) {
    const heard = (await leg.awaitReply({})).text.toLowerCase();
    if (heard.includes("connected")) {
      return;
    }
    if (heard.includes("did you say")) {
      await leg.say("Yes");
    } else if (heard.includes("resume") || heard.includes("start fresh")) {
      await leg.say("Start fresh");
    } else {
      await leg.say(agentName);
    }
  }
  throw new ScenarioFailure(`never heard "Connected" after naming ${agentName}`);
}

/** Say goodbye and see the call out. */
async function sayGoodbye(context: ScenarioContext): Promise<void> {
  await context.leg.say("Goodbye");
  try {
    await awaitUntilWords(context.leg, [["goodbye"]], { timeoutMs: 10_000 });
  } catch {
    // A fast hangup can beat the transcription, and a slow task's leftovers
    // can crowd the window; the end of the call is the real assertion.
  }
  await untilEnded(context.leg, 10_000);
}

const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen"];

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function p90(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.9) - 1)] ?? 0;
}

export const SCENARIOS: Scenario[] = [
  {
    name: "dial-string-pin",
    proves: "the saved contact's post-dial PIN opens the door and the hello follows",
    async run(context) {
      await context.leg.place({});
      const hello = await context.leg.awaitReply({});
      expectWords(hello.text, ["connect"]);
      await context.leg.hangup("end");
    },
  },
  {
    name: "keypad-pin",
    proves: "the PIN keyed by hand after connect authenticates the same way",
    async run(context) {
      await context.leg.place({ pin: "none" });
      await sleep(1_500);
      await context.leg.enterPin();
      const hello = await context.leg.awaitReply({});
      expectWords(hello.text, ["connect"]);
      await context.leg.hangup("end");
    },
  },
  {
    name: "dial-string-pin-hash",
    proves: "the contact string's old trailing # no longer silences the hello (#54)",
    async run(context) {
      await context.leg.place({ hash: true });
      const hello = await context.leg.awaitReply({});
      expectWords(hello.text, ["iva", "connect"]);
      await context.leg.hangup("end");
    },
  },
  {
    name: "keypad-pin-hash",
    proves: "a hand-keyed PIN ending in # hears the whole hello too (#54)",
    async run(context) {
      await context.leg.place({ pin: "none" });
      await sleep(1_500);
      await context.leg.enterPin({ hash: true });
      const hello = await context.leg.awaitReply({});
      expectWords(hello.text, ["iva", "connect"]);
      await context.leg.hangup("end");
    },
  },
  {
    name: "wrong-pin",
    proves: "three wrong PINs are refused one by one and the third ends the call",
    async run(context) {
      await context.leg.place({ pin: "none" });
      await sleep(1_500);
      for (const expected of [["not it"], ["not it"], ["goodbye"]]) {
        await context.leg.press(context.wrongPin);
        await awaitUntilWords(context.leg, [expected], { timeoutMs: 20_000 });
      }
      await untilEnded(context.leg, 15_000);
    },
  },
  {
    name: "pick-and-ask",
    proves: "an agent named by voice answers a real question on its host",
    async run(context) {
      await authAndConnect(context);
      await context.leg.say("What is nineteen plus four? Answer with just the number.");
      const answer = await context.leg.awaitReply({ timeoutMs: 90_000 });
      expectAnyWords(answer.text, [["twenty three"], ["twenty-three"], ["23"]]);
      await sayGoodbye(context);
    },
  },
  {
    name: "drop-and-resume",
    proves: "a call dropped mid-task is offered back on the next call, task intact",
    async run(context) {
      await authAndConnect(context);
      await context.leg.say("Use your shell to run sleep 2 eight times, and after each one say the next number, one through eight.");
      await sleep(4_000);
      await context.leg.hangup("rest");
      await untilEnded(context.leg, 10_000);
      await sleep(2_000);
      await context.leg.place({});
      const hello = await context.leg.awaitReply({});
      expectWords(hello.text, ["connect"]);
      await context.leg.say(context.agentName);
      let offered = false;
      for (let i = 0; i < 5; i++) {
        const heard = (await context.leg.awaitReply({ timeoutMs: 30_000 })).text.toLowerCase();
        if (heard.includes("resume") || heard.includes("fresh")) {
          offered = true;
          break;
        }
        if (heard.includes("did you say")) {
          await context.leg.say("Yes");
        } else {
          await context.leg.say(context.agentName);
        }
      }
      if (!offered) {
        throw new ScenarioFailure("the dropped session was never offered back");
      }
      await context.leg.say("Resume");
      const caught = await context.leg.awaitReply({ timeoutMs: 60_000 });
      expectAnyWords(caught.text, [["still working"], ["while you were away"], ["finished"], ["waiting"], ["rest as it comes"]]);
      context.log(`resume catch-up: "${caught.text}"`);
      await drain(context.leg);
      await sayGoodbye(context);
    },
  },
  {
    name: "barge-in",
    proves: "interrupting the agent three turns running leaves the session answering",
    async run(context) {
      await authAndConnect(context);
      for (let round = 1; round <= 3; round++) {
        await context.leg.say("Count out loud from one to thirty, every single number.");
        const speaking = await waitFor(() => context.leg.status().farSpeaking, 90_000);
        if (!speaking) {
          throw new ScenarioFailure(`round ${round}: the count never started playing`);
        }
        await sleep(1_500);
        await context.leg.say("Stop stop stop, that is enough.", { overSpeech: true });
        await drain(context.leg);
      }
      await context.leg.say("What is two plus five? Answer with just the number.");
      // The stop's own acknowledgement may still be in flight; the answer is
      // whichever of the next few utterances carries it.
      let last = "";
      for (let i = 0; i < 4; i++) {
        last = (await context.leg.awaitReply({ timeoutMs: 60_000 })).text;
        if (/seven|\b7\b/i.test(last)) {
          last = "";
          break;
        }
      }
      if (last !== "") {
        throw new ScenarioFailure(`expected the answer seven after three barge-ins; last heard: "${last}"`);
      }
      await sayGoodbye(context);
    },
  },
  {
    name: "goodbye",
    proves: "the goodbye wrap-up: Aiva answers it and the bridge ends the call",
    async run(context) {
      await authAndConnect(context);
      await sayGoodbye(context);
    },
  },
  {
    name: "turns-20",
    proves: "a twenty-turn session holds up, with the operator-side latency summarised",
    async run(context) {
      await authAndConnect(context);
      const waits: number[] = [];
      for (let i = 0; i < 20; i++) {
        const a = 2 + (i % 5);
        const b = 3 + ((i * 2) % 7);
        // One sentence, one breath: a second sentence can finalize as its
        // own utterance and barge in on the answer to the first (#50).
        await context.leg.say(`What is ${NUMBER_WORDS[a]} plus ${NUMBER_WORDS[b]}?`);
        const answer = await context.leg.awaitReply({ timeoutMs: 60_000 });
        expectAnyWords(answer.text, [[NUMBER_WORDS[a + b] ?? String(a + b)], [String(a + b)]]);
        if (answer.sinceSaidMs !== undefined) {
          waits.push(answer.sinceSaidMs);
        }
      }
      context.log(
        `operator-side wait over ${waits.length} turns: median ${median(waits)} ms, p90 ${p90(waits)} ms ` +
          `(say-end → reply transcribed; the bridge's own share is its "turn latency" log line)`,
      );
      await sayGoodbye(context);
    },
  },
  {
    name: "unlisted-caller",
    proves: "a caller not on the allow-list is dropped silently, before any word",
    skip(context) {
      return context.unlistedFrom === undefined
        ? "needs a second caller identity (set THICKET_PHONE_TEST_UNLISTED_FROM to a verified caller id the bridge does not allow-list)"
        : undefined;
    },
    async run(context) {
      await context.leg.place({ pin: "none", from: context.unlistedFrom! });
      try {
        const heard = await context.leg.awaitReply({ timeoutMs: 8_000 });
        throw new ScenarioFailure(`an unlisted caller was spoken to: "${heard.text}"`);
      } catch (err) {
        if (err instanceof ScenarioFailure) {
          throw err;
        }
        // Nothing heard is the point.
      }
      await untilEnded(context.leg, 15_000);
    },
  },
];

async function waitFor(pred: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() >= deadline) {
      return false;
    }
    await sleep(500);
  }
  return true;
}
