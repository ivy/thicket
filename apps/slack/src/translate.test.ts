import test from "node:test";
import assert from "node:assert/strict";

import { translateSlackEvent, translateSlackInteraction } from "./translate.js";

const DM = {
  type: "message",
  channel: "D1",
  channel_type: "im",
  ts: "1.1",
  text: "hello",
  user: "U-human",
};

test("a DM becomes a dm event rooted at its own ts", () => {
  assert.deepEqual(translateSlackEvent({ ...DM }), {
    kind: "dm",
    channel: "D1",
    threadTs: "1.1",
    text: "hello",
    messageTs: "1.1",
    files: [],
    authorId: "U-human",
    viaApp: false,
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

test("authorless posts and uninteresting subtypes stay dropped", () => {
  // A classic bot post has no author at all.
  assert.equal(translateSlackEvent({ ...DM, user: undefined, bot_id: "B1" }), undefined);
  assert.equal(translateSlackEvent({ ...DM, subtype: "message_changed" }), undefined);
  assert.equal(translateSlackEvent({ ...DM, subtype: "channel_join" }), undefined);
});

test("bot_id is reported, not obeyed", () => {
  // Posting through any app's user token stamps the app's bot_id onto a
  // human's message, so this layer records the fact and leaves the
  // judgement to whoever can resolve the author.
  const event = translateSlackEvent({ ...DM, bot_id: "B1" });
  assert.equal(event?.kind, "dm");
  assert.equal(event?.kind === "dm" ? event.viaApp : undefined, true);
  assert.equal(event?.kind === "dm" ? event.authorId : undefined, "U-human");
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
    {
      kind: "mention",
      channel: "C1",
      threadTs: "2.0",
      text: "<@U1> look",
      messageTs: "2.2",
      files: [],
      authorId: "",
      viaApp: false,
    },
  );
});

test("channel chatter counts only inside a thread", () => {
  assert.equal(
    translateSlackEvent({
      type: "message",
      channel: "C1",
      ts: "3.1",
      text: "chatter",
      user: "U-human",
    }),
    undefined,
  );
  assert.equal(
    translateSlackEvent({
      type: "message",
      channel: "C1",
      ts: "3.2",
      thread_ts: "3.0",
      text: "chatter",
      user: "U-human",
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

test("uploads are carried with the fields the bridge needs to serve them", () => {
  const event = translateSlackEvent({
    ...DM,
    subtype: "file_share",
    files: [
      {
        id: "F1",
        name: "quarterly.csv",
        mimetype: "text/csv",
        size: 2048,
        url_private: "https://files.slack.com/view/F1",
        url_private_download: "https://files.slack.com/download/F1",
      },
    ],
  });
  assert.deepEqual(event?.kind === "dm" ? event.files : [], [
    {
      id: "F1",
      name: "quarterly.csv",
      mimetype: "text/csv",
      size: 2048,
      // the download form, not the viewer page
      downloadUrl: "https://files.slack.com/download/F1",
    },
  ]);
});

test("a file with no retrievable bytes is skipped, not half-recorded", () => {
  const event = translateSlackEvent({
    ...DM,
    subtype: "file_share",
    files: [
      { id: "F1", name: "still-uploading.zip" },
      { name: "no-id.txt", url_private_download: "https://files.slack.com/download/F2" },
      "not an object",
      { id: "F3", url_private: "https://files.slack.com/view/F3" },
    ],
  });
  const files = event?.kind === "dm" ? event.files : [];
  assert.deepEqual(
    files.map((f) => f.id),
    ["F3"],
  );
  // Missing name and mimetype fall back rather than becoming "undefined".
  assert.equal(files[0]?.name, "F3");
  assert.equal(files[0]?.mimetype, "application/octet-stream");
  assert.equal(files[0]?.size, 0);
});

const TAP = {
  type: "block_actions",
  user: { id: "U-human", username: "ivy" },
  channel: { id: "D1", name: "directmessage" },
  message: { ts: "1.2", thread_ts: "1.1", text: "Which environment should I deploy to?" },
  container: { type: "message", message_ts: "1.2", channel_id: "D1", is_ephemeral: false },
  actions: [
    {
      type: "button",
      action_id: "thicket_q:answer:0:1",
      block_id: "thicket_q:0",
      value: "0:1",
      action_ts: "1724650002.000001",
    },
  ],
  response_url: "https://hooks.slack.com/actions/x",
};

test("a button tap unwraps to a block_action with the message it landed on", () => {
  assert.deepEqual(translateSlackInteraction(TAP), {
    kind: "block_action",
    channel: "D1",
    messageTs: "1.2",
    threadTs: "1.1",
    userId: "U-human",
    actions: [{ actionId: "thicket_q:answer:0:1", blockId: "thicket_q:0", value: "0:1" }],
  });
});

test("a form's selections arrive both on the action and in the message state", () => {
  const event = translateSlackInteraction({
    ...TAP,
    actions: [
      {
        type: "checkboxes",
        action_id: "thicket_q:answer:1",
        block_id: "thicket_q:1",
        selected_options: [{ value: "1:0" }, { value: "1:2" }],
      },
    ],
    state: {
      values: {
        "thicket_q:0": { "thicket_q:answer:0": { type: "radio_buttons", selected_option: { value: "0:1" } } },
        "thicket_q:1": {
          "thicket_q:answer:1": { type: "checkboxes", selected_options: [{ value: "1:0" }, { value: "1:2" }] },
        },
      },
    },
  });
  assert.ok(event?.kind === "block_action");
  assert.deepEqual(event.actions[0]?.selected, ["1:0", "1:2"]);
  assert.deepEqual(event.state, {
    "thicket_q:0": { "thicket_q:answer:0": ["0:1"] },
    "thicket_q:1": { "thicket_q:answer:1": ["1:0", "1:2"] },
  });
});

test("interactions that are not block_actions on a message are ignored", () => {
  assert.equal(translateSlackInteraction({ ...TAP, type: "view_submission" }), undefined);
  assert.equal(translateSlackInteraction({ ...TAP, channel: undefined, container: {} }), undefined);
  assert.equal(translateSlackInteraction({ ...TAP, actions: [] }), undefined);
});
