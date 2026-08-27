import test from "node:test";
import assert from "node:assert/strict";

import { translateSlackEvent } from "./translate.js";

const DM = {
  type: "message",
  channel: "D1",
  channel_type: "im",
  ts: "1.1",
  text: "hello",
};

test("a DM becomes a dm event rooted at its own ts", () => {
  assert.deepEqual(translateSlackEvent({ ...DM }), {
    kind: "dm",
    channel: "D1",
    threadTs: "1.1",
    text: "hello",
    messageTs: "1.1",
  });
});

test("a DM carrying an upload is delivered, not dropped as a subtype", () => {
  const event = translateSlackEvent({
    ...DM,
    subtype: "file_share",
    text: "what's wrong here?",
    files: [{ id: "F1", name: "shot.png", mimetype: "image/png", size: 1024 }],
  });
  assert.equal(event?.kind, "dm");
  assert.equal(event?.kind === "dm" ? event.text : "", "what's wrong here?");
});

test("bot echoes and other subtypes stay dropped", () => {
  assert.equal(translateSlackEvent({ ...DM, bot_id: "B1" }), undefined);
  assert.equal(translateSlackEvent({ ...DM, subtype: "message_changed" }), undefined);
  assert.equal(translateSlackEvent({ ...DM, subtype: "channel_join" }), undefined);
  // bot_id wins even on an upload: our own file posts must not loop.
  assert.equal(
    translateSlackEvent({ ...DM, subtype: "file_share", bot_id: "B1" }),
    undefined,
  );
});

test("a mention threads under the message it replies to", () => {
  assert.deepEqual(
    translateSlackEvent({
      type: "app_mention",
      channel: "C1",
      ts: "2.2",
      thread_ts: "2.0",
      text: "<@U1> look",
    }),
    { kind: "mention", channel: "C1", threadTs: "2.0", text: "<@U1> look", messageTs: "2.2" },
  );
});

test("channel chatter counts only inside a thread", () => {
  assert.equal(
    translateSlackEvent({ type: "message", channel: "C1", ts: "3.1", text: "chatter" }),
    undefined,
  );
  assert.equal(
    translateSlackEvent({
      type: "message",
      channel: "C1",
      ts: "3.2",
      thread_ts: "3.0",
      text: "chatter",
    })?.kind,
    "thread_message",
  );
});

test("a session stop is read from either layout, and needs both coordinates", () => {
  assert.deepEqual(
    translateSlackEvent({
      type: "agent_session_stopped",
      session: { channel_id: "D1", thread_ts: "1.1" },
    }),
    { kind: "session_stopped", channel: "D1", threadTs: "1.1" },
  );
  assert.deepEqual(
    translateSlackEvent({ type: "agent_session_stopped", channel_id: "D1", thread_ts: "1.1" }),
    { kind: "session_stopped", channel: "D1", threadTs: "1.1" },
  );
  assert.equal(translateSlackEvent({ type: "agent_session_stopped", channel_id: "D1" }), undefined);
});

test("unknown event types are ignored", () => {
  assert.equal(translateSlackEvent({ type: "reaction_added" }), undefined);
});
