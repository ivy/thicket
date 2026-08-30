import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { twilioSignature } from "@thicket/phone";
import WebSocket from "ws";

import type { CreateCallOptions, TwilioRestPort } from "./caller.js";
import { CallerLeg } from "./leg.js";

const SECRET = "cafef00dcafef00dcafef00d";
const BASE = "https://phone.example.net";
const PREFIX = "/operator";
const TOKEN = "auth-token";
const PIN = "31415926";

const silent = { info: () => undefined, warn: () => undefined };

class FakeRest implements TwilioRestPort {
  calls: CreateCallOptions[] = [];
  sids: string[] = [];
  completed: string[] = [];
  createCall(options: CreateCallOptions): Promise<string> {
    this.calls.push(options);
    const sid = "CA" + String(this.calls.length).padStart(32, "0");
    this.sids.push(sid);
    return Promise.resolve(sid);
  }
  completeCall(sid: string): Promise<void> {
    this.completed.push(sid);
    return Promise.resolve();
  }
}

interface Rig {
  leg: CallerLeg;
  server: Server;
  port: number;
  rest: FakeRest;
  dir: string;
  close(): Promise<void>;
}

async function startLeg(): Promise<Rig> {
  const dir = mkdtempSync(join(tmpdir(), "phone-test-leg-"));
  const rest = new FakeRest();
  const leg = new CallerLeg({
    publicBaseUrl: BASE,
    pathPrefix: PREFIX,
    authToken: TOKEN,
    pin: PIN,
    rest,
    recordingsDir: dir,
    logger: silent,
    relaySecret: SECRET,
    retryPauseMs: 10,
  });
  const server = leg.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as { port: number }).port;
  return {
    leg,
    server,
    port,
    rest,
    dir,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Connects the way Twilio does: stripped path, signature over the prefixed wss URL. */
function connect(port: number): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/relay/${SECRET}`, {
    headers: { "x-twilio-signature": twilioSignature(TOKEN, `wss://phone.example.net${PREFIX}/relay/${SECRET}`) },
  });
  return new Promise((resolve, reject) => {
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

async function until(pred: () => boolean, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    assert.ok(Date.now() < deadline, "condition not reached in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const SETUP = {
  type: "setup",
  sessionId: "VX" + "1".repeat(32),
  callSid: "CAtest0001",
  from: "+15550100001",
  to: "+15550100001",
  direction: "outbound-api",
  callStatus: "IN_PROGRESS",
};

test("a whole session: place, say, hear, key, hang up — with the PIN nowhere", async () => {
  const rig = await startLeg();
  try {
    const placing = rig.leg.place({});
    await until(() => rig.rest.calls.length === 1);
    const created = rig.rest.calls[0]!;
    assert.equal(created.sendDigits, `ww${PIN}`, "post-dial digits, no trailing # (#54)");
    assert.match(created.twiml, /interruptible="none"/);
    assert.match(created.twiml, new RegExp(`wss://phone\\.example\\.net${PREFIX}/relay/${SECRET}`));

    const ws = await connect(rig.port);
    const frames: Array<Record<string, unknown>> = [];
    ws.on("message", (data) => frames.push(JSON.parse(String(data)) as Record<string, unknown>));
    ws.send(JSON.stringify(SETUP));
    const placed = await placing;
    assert.equal(placed.attempts, 1);
    assert.equal(placed.callSid, "CAtest0001");

    const saying = rig.leg.say("hello there");
    await until(() => frames.some((frame) => frame.type === "text" && frame.last === true));
    assert.deepEqual(
      frames.filter((frame) => frame.type === "text").map((frame) => [frame.token, frame.last]),
      [
        ["hello", false],
        [" there", true],
      ],
    );
    ws.send(JSON.stringify({ type: "info", name: "agentSpeaking", value: "on" }));
    ws.send(JSON.stringify({ type: "info", name: "agentSpeaking", value: "off" }));
    const said = await saying;
    assert.equal(said.playbackObserved, true);

    ws.send(JSON.stringify({ type: "prompt", voicePrompt: "Shall I connect you to hearth?", last: true, lang: "en" }));
    const heard = await rig.leg.awaitReply({ timeoutMs: 2_000 });
    assert.match(heard.text, /connect you/);
    assert.ok(typeof heard.sinceSaidMs === "number" && heard.sinceSaidMs >= 0);

    await rig.leg.enterPin();
    await until(() => frames.some((frame) => frame.type === "sendDigits"));
    assert.equal(frames.find((frame) => frame.type === "sendDigits")?.digits, PIN);
    const keyed = rig.leg.transcript().filter((entry) => entry.who === "keyed");
    assert.ok(keyed.every((entry) => !entry.text.includes(PIN)));
    assert.ok(keyed.some((entry) => entry.text === "#".repeat(8)));

    const hanging = rig.leg.hangup("end");
    await until(() => frames.some((frame) => frame.type === "end"));
    ws.close(1000);
    await hanging;
    assert.equal(rig.leg.status().call, null);

    const recorded = readdirSync(rig.dir)
      .map((file) => readFileSync(join(rig.dir, file), "utf8"))
      .join("");
    assert.ok(recorded.length > 0, "the call was recorded");
    assert.ok(!recorded.includes(PIN), "the PIN reached no recording");
  } finally {
    await rig.close();
  }
});

test("a busy edge is retried, and the dead attempt is completed", async () => {
  const rig = await startLeg();
  try {
    const placing = rig.leg.place({ attempts: 2 });
    await until(() => rig.rest.calls.length === 1);
    const firstSid = rig.rest.sids[0]!;
    const form = { CallSid: firstSid, CallStatus: "busy" };
    const response = await fetch(`http://127.0.0.1:${rig.port}/status`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": twilioSignature(TOKEN, `${BASE}${PREFIX}/status`, form),
      },
      body: new URLSearchParams(form),
    });
    assert.equal(response.status, 204);
    await until(() => rig.rest.calls.length === 2);
    assert.deepEqual(rig.rest.completed, [firstSid]);
    const ws = await connect(rig.port);
    ws.send(JSON.stringify(SETUP));
    const placed = await placing;
    assert.equal(placed.attempts, 2);
    ws.close(1000);
  } finally {
    await rig.close();
  }
});

test("a handshake without Twilio's signature is refused", async () => {
  const rig = await startLeg();
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${rig.port}/relay/${SECRET}`);
    // The client library reports only that the upgrade never happened
    // (the server answered 403 and closed), not the status itself.
    const err = await new Promise<Error>((resolve) => ws.on("error", resolve));
    assert.match(err.message, /403|Unexpected server response|Expected 101/);
  } finally {
    await rig.close();
  }
});

test("a webhook with a bad signature is refused", async () => {
  const rig = await startLeg();
  try {
    const response = await fetch(`http://127.0.0.1:${rig.port}/status`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": "nope" },
      body: new URLSearchParams({ CallSid: "CAx", CallStatus: "busy" }),
    });
    assert.equal(response.status, 403);
  } finally {
    await rig.close();
  }
});

test("awaiting with no call explains itself", async () => {
  const rig = await startLeg();
  try {
    await assert.rejects(rig.leg.awaitReply({ timeoutMs: 100 }), /ended before|nothing heard/);
  } finally {
    await rig.close();
  }
});
