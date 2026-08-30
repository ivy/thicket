import test from "node:test";
import assert from "node:assert/strict";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { buildPhoneTestServer, type PhoneTestLegPort } from "./server.js";
import type { TranscriptEntry } from "./leg.js";

interface ToolResult {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
}

function stubLeg(overrides: Partial<PhoneTestLegPort> = {}): PhoneTestLegPort & { verbs: string[] } {
  const verbs: string[] = [];
  return {
    verbs,
    place: (options) => {
      verbs.push(`place:${options.pin ?? "dial"}`);
      return Promise.resolve({ callSid: "CAstub0001", attempts: 2 });
    },
    say: (text, options) => {
      verbs.push(`say:${text}${options?.overSpeech === true ? ":over" : ""}`);
      return Promise.resolve({ playbackObserved: true });
    },
    press: (digits) => {
      verbs.push(`press:${digits.length}`);
      return Promise.resolve();
    },
    enterPin: () => {
      verbs.push("pin");
      return Promise.resolve();
    },
    awaitReply: () => Promise.resolve({ text: "Connected to Hearth.", atMs: 1234, sinceSaidMs: 2100 }),
    transcript: (): TranscriptEntry[] => [
      { ms: 10, who: "keyed", text: "########" },
      { ms: 20, who: "heard", text: "Shall I connect you to hearth?" },
    ],
    status: () => ({ call: { callSid: "CAstub0001", sinceSetupMs: 5000 }, farSpeaking: true, selfSpeaking: false, heardPending: 1 }),
    hangup: () => Promise.resolve(),
    ...overrides,
  };
}

async function connect(leg: PhoneTestLegPort): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = buildPhoneTestServer({ leg });
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

function textOf(result: unknown): string {
  return (result as ToolResult).content[0]?.text ?? "";
}

test("the session verbs round-trip through the tools", async () => {
  const leg = stubLeg();
  const client = await connect(leg);

  assert.match(textOf(await client.callTool({ name: "phone_call", arguments: {} })), /callSid=CAstub0001 attempts=2/);
  assert.match(textOf(await client.callTool({ name: "phone_say", arguments: { text: "Hearth" } })), /spoken/);
  assert.match(
    textOf(await client.callTool({ name: "phone_await_reply", arguments: {} })),
    /Connected to Hearth\./,
  );
  assert.match(
    textOf(await client.callTool({ name: "phone_await_reply", arguments: {} })),
    /2100ms after the last say/,
  );
  assert.match(textOf(await client.callTool({ name: "phone_press", arguments: { digits: "12w#" } })), /4 digit/);
  assert.match(textOf(await client.callTool({ name: "phone_enter_pin", arguments: {} })), /PIN keyed/);
  assert.match(textOf(await client.callTool({ name: "phone_status", arguments: {} })), /far speaking/);
  assert.match(textOf(await client.callTool({ name: "phone_hangup", arguments: {} })), /call ended/);
  assert.deepEqual(leg.verbs, ["place:dial", "say:Hearth", "press:4", "pin"]);
});

test("a barge-in say is queued, not awaited", async () => {
  const leg = stubLeg();
  const client = await connect(leg);
  assert.match(
    textOf(await client.callTool({ name: "phone_say", arguments: { text: "stop", over_speech: true } })),
    /queued over/,
  );
  assert.ok(leg.verbs.includes("say:stop:over"));
});

test("the transcript renders masked digits, never raw ones", async () => {
  const client = await connect(stubLeg());
  const rendered = textOf(await client.callTool({ name: "phone_transcript", arguments: {} }));
  assert.match(rendered, /keyed +########/);
  assert.match(rendered, /heard +Shall I connect/);
});

test("a leg failure is an error result with the leg's own words", async () => {
  const client = await connect(
    stubLeg({
      place: () => Promise.reject(new Error("no call after 3 attempts — the Funnel edge refuses intermittently")),
    }),
  );
  const result = (await client.callTool({ name: "phone_call", arguments: {} })) as ToolResult;
  assert.equal(result.isError, true);
  assert.match(result.content[0]?.text ?? "", /Funnel edge/);
});
