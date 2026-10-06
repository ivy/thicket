import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { translateDispatch } from "./translate.js";
import type { CommandEvent, ComponentEvent, MessageEvent, ModalEvent } from "./types.js";

const FIXTURES = join(import.meta.dirname, "../../../tests/fixtures/discord");

/** Every dispatch of one type in a recording, in order. */
function dispatches(file: string, type: string): Record<string, unknown>[] {
  return readFileSync(join(FIXTURES, file), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { kind: string; t?: string; d?: Record<string, unknown> })
    .filter((entry) => entry.kind === "dispatch" && entry.t === type)
    .map((entry) => entry.d!);
}

function messages(file: string): MessageEvent[] {
  return dispatches(file, "MESSAGE_CREATE")
    .map((d) => translateDispatch("MESSAGE_CREATE", d))
    .filter((e): e is MessageEvent => e?.kind === "message");
}

test("a human message in a channel: author, no app, content, no mention", () => {
  const plain = messages("nocontent.jsonl").find((m) => !m.authorIsApp && m.mentions.length === 0 && m.guild !== undefined && m.replyTo === undefined);
  assert.ok(plain);
  assert.equal(plain.type, 0);
  assert.equal(plain.text, "", "without the content intent an unmentioned message is empty");
  assert.deepEqual(plain.files, []);
});

test("a mention lists the bot among the mentions and carries content", () => {
  const recorded = messages("interactions.jsonl");
  const mention = recorded.find((m) => !m.authorIsApp && m.mentions.length > 0 && m.files.length === 0);
  assert.ok(mention);
  assert.ok(mention.text.includes(`<@${mention.mentions[0]}>`));
  assert.ok(mention.text.length > 0);
});

test("a DM has no guild", () => {
  const dm = messages("nocontent.jsonl").find((m) => m.guild === undefined && !m.authorIsApp);
  assert.ok(dm);
  assert.ok(dm.text.length > 0, "a DM carries content without the intent");
});

test("a reply with the ping on mentions the bot; with it off it does not", () => {
  const replies = messages("nocontent.jsonl").filter((m) => !m.authorIsApp && m.replyTo !== undefined);
  assert.equal(replies.length, 2);
  const [on, off] = replies;
  assert.ok(on!.mentions.length > 0 && on!.text.length > 0);
  assert.ok(off!.mentions.length === 0 && off!.text.length === 0);
});

test("an attachment arrives with its signed CDN URL", () => {
  const withFile = messages("interactions.jsonl").find((m) => !m.authorIsApp && m.files.length > 0);
  assert.ok(withFile);
  const [file] = withFile.files;
  assert.equal(file!.contentType, "image/png");
  assert.ok(file!.size > 0);
  assert.ok(new URL(file!.url).host.endsWith("discordapp.com"));
  assert.ok(new URL(file!.url).searchParams.has("hm"), "signed");
});

test("the bot's own messages, including interaction responses, are flagged as app-authored", () => {
  const own = messages("interactions.jsonl").filter((m) => m.authorIsApp);
  assert.ok(own.length > 0);
  const webhook = dispatches("interactions.jsonl", "MESSAGE_CREATE").find((d) => d.webhook_id !== undefined);
  assert.ok(webhook, "an interaction response carries webhook_id");
  assert.equal(translateDispatch("MESSAGE_CREATE", webhook)?.kind, "message");
  assert.equal((translateDispatch("MESSAGE_CREATE", webhook) as MessageEvent).authorIsApp, true);
});

test("a thread starter message is type 21 and a command response type 20", () => {
  const types = new Set(messages("interactions.jsonl").concat(messages("rest.jsonl")).map((m) => m.type));
  assert.ok(types.has(0));
  assert.ok(types.has(19) || types.has(21));
});

test("a select pick is a component event with its values", () => {
  const picks = dispatches("nocontent.jsonl", "INTERACTION_CREATE")
    .map((d) => translateDispatch("INTERACTION_CREATE", d))
    .filter((e): e is ComponentEvent => e?.kind === "component" && e.customId === "pick");
  assert.ok(picks.length > 0);
  assert.equal(picks[0]!.componentType, 3);
  assert.deepEqual(picks[0]!.values, ["linux-x64"]);
  assert.ok(picks[0]!.messageId);
  assert.ok(picks[0]!.token);
});

test("a button tap is a component event with no values", () => {
  const stop = dispatches("interactions.jsonl", "INTERACTION_CREATE")
    .map((d) => translateDispatch("INTERACTION_CREATE", d))
    .find((e): e is ComponentEvent => e?.kind === "component" && e.customId === "stop");
  assert.ok(stop);
  assert.equal(stop.componentType, 2);
  assert.deepEqual(stop.values, []);
});

test("a slash command is a command event", () => {
  const command = dispatches("interactions.jsonl", "INTERACTION_CREATE")
    .map((d) => translateDispatch("INTERACTION_CREATE", d))
    .find((e): e is CommandEvent => e?.kind === "command");
  assert.ok(command);
  assert.equal(command.name, "spike");
  assert.ok(command.guild);
});

test("a submitted form unwraps every Label: radio, checkboxes, text, file", () => {
  const modal = dispatches("nocontent.jsonl", "INTERACTION_CREATE")
    .map((d) => translateDispatch("INTERACTION_CREATE", d))
    .find((e): e is ModalEvent => e?.kind === "modal");
  assert.ok(modal);
  assert.equal(modal.customId, "q1");
  const byId = Object.fromEntries(modal.fields.map((f) => [f.customId, f]));
  assert.deepEqual(byId.platforms, { customId: "platforms", type: 21, value: "macos-arm64" });
  assert.deepEqual(byId.also, { customId: "also", type: 22, values: ["test", "lint"] });
  assert.equal(byId.other?.type, 4);
  assert.ok(byId.other?.value);
  assert.equal(byId.log?.type, 19);
  assert.equal(modal.attachments.length, 1);
  assert.equal(modal.attachments[0]!.id, byId.log?.values?.[0]);
  assert.ok(modal.attachments[0]!.url.includes("ephemeral-attachments"));
});

test("a message without an author is dropped", () => {
  assert.equal(translateDispatch("MESSAGE_CREATE", { id: "1", channel_id: "2", content: "x" }), undefined);
  assert.equal(translateDispatch("THREAD_CREATE", { id: "1" }), undefined);
});

test("a forward is not a reply: its reference has type 1 and its text arrives as a snapshot", () => {
  const forward = translateDispatch("MESSAGE_CREATE", {
    id: "f1",
    channel_id: "dm",
    type: 0,
    content: "",
    author: { id: "u1", username: "ivy" },
    mentions: [],
    attachments: [],
    message_reference: { type: 1, message_id: "orig", channel_id: "c", guild_id: "g" },
    message_snapshots: [{ message: { content: "the forwarded words", attachments: [] } }],
  }) as MessageEvent;
  assert.equal(forward.replyTo, undefined);
  assert.deepEqual(forward.forwards, [{ text: "the forwarded words", files: [] }]);

  const reply = translateDispatch("MESSAGE_CREATE", {
    id: "r1",
    channel_id: "dm",
    type: 19,
    content: "yes",
    author: { id: "u1", username: "ivy", global_name: "Ivy" },
    mentions: [{ id: "bot", username: "thicket-dev", bot: true }],
    attachments: [],
    message_reference: { type: 0, message_id: "orig" },
    referenced_message: { id: "orig", author: { id: "bot", username: "thicket-dev", bot: true }, content: "earlier", attachments: [] },
  }) as MessageEvent;
  assert.equal(reply.replyTo, "orig");
  assert.equal(reply.authorName, "Ivy");
  assert.deepEqual(reply.mentionNames, { bot: "thicket-dev" });
  assert.deepEqual(reply.reply, { author: { id: "bot", name: "thicket-dev", isApp: true }, text: "earlier", files: [] });
});
