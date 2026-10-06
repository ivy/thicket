import test from "node:test";
import assert from "node:assert/strict";

import type { Message } from "@a2a-js/sdk";

import { envelopeOf, envelopePreamble, linksIn, META_ENVELOPE, type Envelope } from "./envelope.js";

function message(envelope?: unknown): Message {
  return {
    messageId: "m",
    contextId: "c",
    taskId: "",
    role: 1,
    parts: [],
    metadata: envelope === undefined ? {} : { [META_ENVELOPE]: envelope },
    extensions: [],
    referenceTaskIds: [],
  };
}

test("no envelope, or a malformed one, renders nothing", () => {
  assert.equal(envelopePreamble(message()), "");
  assert.equal(envelopePreamble(message({ surface: "irc", place: { channel: "x" } })), "");
  assert.equal(envelopeOf(message({ surface: "slack" })), undefined);
});

test("a Slack thread renders its coordinates and the same instruction as before", () => {
  const env: Envelope = {
    surface: "slack",
    place: { kind: "channel", channel: "C42", thread: "1724650000.000100", message: "1724650000.000200" },
  };
  const text = envelopePreamble(message(env));
  assert.match(text, /^You are in Slack channel C42, thread 1724650000\.000100\. Your reply reaches it on its own/);
  assert.ok(text.endsWith("\n\n"));
});

test("a Discord DM names the surface and the place kind, and omits a thread equal to the channel", () => {
  const env: Envelope = { surface: "discord", place: { kind: "DM", channel: "dm-1", thread: "dm-1", message: "m1" } };
  assert.match(envelopePreamble(message(env)), /^You are in Discord DM dm-1\. /);
});

test("author, mentions, a reply, a forward and a link each get a line", () => {
  const env: Envelope = {
    surface: "discord",
    place: { kind: "thread", channel: "chan", thread: "th", message: "m2" },
    author: { id: "u1", name: "ivy", kind: "operator" },
    mentions: [
      { id: "bot", name: "hearth", kind: "agent", self: true },
      { id: "u2", name: "martin", kind: "person" },
      { id: "r1", kind: "role" },
    ],
    references: [
      {
        kind: "reply",
        message: "m0",
        author: { id: "bot", name: "hearth", kind: "agent", self: true },
        text: "Earlier I said   this.",
        attachments: [{ name: "a.png", mediaType: "image/png", size: 12, url: "https://cdn.example/a.png" }],
      },
      { kind: "forward", text: "a forwarded note" },
      { kind: "link", url: "https://example.com/x", title: "Example" },
    ],
  };
  const text = envelopePreamble(message(env));
  assert.match(text, /The message is from ivy <u1>, your operator\./);
  assert.match(text, /It mentions martin <u2>, r1 \(a role\)\./, "the agent itself is not listed as a mention");
  assert.match(text, /It replies to you, who said "Earlier I said this\."\. It carried a\.png \(image\/png, 12 bytes, at https:\/\/cdn\.example\/a\.png\)\./);
  assert.match(text, /It forwards a message from someone: "a forwarded note"\./);
  assert.match(text, /It links to https:\/\/example\.com\/x \(Example\)\./);
});

test("a quoted reply is flattened and cut at 300 characters", () => {
  const env: Envelope = {
    surface: "slack",
    place: { kind: "DM", channel: "D1" },
    references: [{ kind: "reply", message: "m", text: "x".repeat(400) }],
  };
  const text = envelopePreamble(message(env));
  assert.match(text, /who said "x{299}…"\./);
});

test("linksIn finds http(s) links once each, without trailing punctuation or Slack's brackets", () => {
  assert.deepEqual(
    linksIn("see https://a.example/path, and <https://b.example|B> and https://a.example/path."),
    ["https://a.example/path", "https://b.example"],
  );
  assert.deepEqual(linksIn("no links here"), []);
});
