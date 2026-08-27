import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { Readable } from "node:stream";

import { buildFileServer, parsePeerTags, PEER_TAGS_HEADER } from "./http.js";
import { BridgeState } from "./state.js";

async function errorOf(res: Response): Promise<string> {
  return String(((await res.json()) as { error?: unknown }).error);
}

const HEARTH_TAG = "tag:thicket-hearth";
const FORGE_TAG = "tag:thicket-forge";

interface Rig {
  url: string;
  state: BridgeState;
  server: Server;
  upstream: { calls: { url: string; auth: string | null }[] };
  close(): Promise<void>;
}

async function rig(
  respond: () => Response = () => new Response("file bytes", { status: 200 }),
): Promise<Rig> {
  const state = new BridgeState(":memory:");
  const upstream = { calls: [] as { url: string; auth: string | null }[] };
  const app = buildFileServer({
    state,
    agentByTag: new Map([
      [HEARTH_TAG, "hearth"],
      [FORGE_TAG, "forge"],
    ]),
    botTokenFor: (agent) => (agent === "hearth" ? "xoxb-hearth" : "xoxb-forge"),
    logger: { info: () => {}, warn: () => {} },
    fetchImpl: async (input, init) => {
      upstream.calls.push({
        url: String(input),
        auth: new Headers(init?.headers).get("authorization"),
      });
      return respond();
    },
  });
  const server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("no address");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    state,
    server,
    upstream,
    close: async () => {
      state.close();
      server.close();
      await once(server, "close");
    },
  };
}

function recordHearthFile(state: BridgeState, fileId = "F1"): void {
  state.recordFile({
    fileId,
    agent: "hearth",
    channel: "D1",
    threadTs: "1.1",
    name: "quarterly.csv",
    mimetype: "text/csv",
    size: 2048,
    url: `https://files.slack.com/download/${fileId}`,
  });
}

test("peer tags parse from the header netd stamps", () => {
  assert.deepEqual(parsePeerTags("tag:a, tag:b"), ["tag:a", "tag:b"]);
  assert.deepEqual(parsePeerTags(""), []);
  assert.deepEqual(parsePeerTags(undefined), []);
});

test("an authorized agent gets the bytes, and the bot token never leaves the bridge", async (t) => {
  const r = await rig();
  t.after(() => r.close());
  recordHearthFile(r.state);

  const res = await fetch(`${r.url}/files/F1`, {
    headers: { [PEER_TAGS_HEADER]: HEARTH_TAG },
  });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "file bytes");
  assert.equal(res.headers.get("content-type"), "text/csv");
  assert.match(res.headers.get("content-disposition") ?? "", /quarterly\.csv/);
  assert.deepEqual(r.upstream.calls, [
    { url: "https://files.slack.com/download/F1", auth: "Bearer xoxb-hearth" },
  ]);
});

test("an unauthenticated caller is refused before any lookup", async (t) => {
  const r = await rig();
  t.after(() => r.close());
  recordHearthFile(r.state);

  const res = await fetch(`${r.url}/files/F1`);
  assert.equal(res.status, 403);
  assert.match(await errorOf(res), /peer identity missing/);
  assert.equal(r.upstream.calls.length, 0, "Slack was never called");
});

test("an unknown tag names no agent and is refused", async (t) => {
  const r = await rig();
  t.after(() => r.close());
  recordHearthFile(r.state);

  const res = await fetch(`${r.url}/files/F1`, {
    headers: { [PEER_TAGS_HEADER]: "tag:thicket-stranger" },
  });
  assert.equal(res.status, 403);
  assert.equal(r.upstream.calls.length, 0);
});

test("another agent's file is indistinguishable from one that does not exist", async (t) => {
  const r = await rig();
  t.after(() => r.close());
  recordHearthFile(r.state);

  const theirs = await fetch(`${r.url}/files/F1`, {
    headers: { [PEER_TAGS_HEADER]: FORGE_TAG },
  });
  const missing = await fetch(`${r.url}/files/F-nonexistent`, {
    headers: { [PEER_TAGS_HEADER]: FORGE_TAG },
  });
  assert.equal(theirs.status, 404);
  assert.equal(missing.status, 404);
  assert.deepEqual(await theirs.json(), await missing.json());
  assert.equal(r.upstream.calls.length, 0, "no fetch on a denied file");
});

test("a Slack refusal surfaces as a gateway error, not as empty bytes", async (t) => {
  const r = await rig(() => new Response("nope", { status: 404 }));
  t.after(() => r.close());
  recordHearthFile(r.state);

  const res = await fetch(`${r.url}/files/F1`, {
    headers: { [PEER_TAGS_HEADER]: HEARTH_TAG },
  });
  assert.equal(res.status, 502);
  assert.match(await errorOf(res), /slack returned 404/);
});

function slackOk(extra: Record<string, unknown> = {}): Response {
  return Response.json({ ok: true, ...extra });
}

function slackError(code: string): Response {
  return Response.json({ ok: false, error: code });
}

test("an agent posts a message through the bridge; the token stays on the bridge", async (t) => {
  const r = await rig(() => slackOk({ channel: "C42", ts: "9.9" }));
  t.after(() => r.close());

  const res = await fetch(`${r.url}/api/messages`, {
    method: "POST",
    headers: { [PEER_TAGS_HEADER]: HEARTH_TAG, "content-type": "application/json" },
    body: JSON.stringify({ channel: "C42", text: "routine output" }),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, channel: "C42", ts: "9.9" });
  assert.equal(r.upstream.calls.length, 1);
  assert.equal(r.upstream.calls[0]!.url, "https://slack.com/api/chat.postMessage");
  assert.equal(r.upstream.calls[0]!.auth, "Bearer xoxb-hearth", "hearth's own token, held by the bridge");
});

test("a channel the app is not in is refused as an authorization decision", async (t) => {
  const r = await rig(() => slackError("not_in_channel"));
  t.after(() => r.close());

  const res = await fetch(`${r.url}/api/messages`, {
    method: "POST",
    headers: { [PEER_TAGS_HEADER]: HEARTH_TAG, "content-type": "application/json" },
    body: JSON.stringify({ channel: "C99", text: "hello?" }),
  });
  assert.equal(res.status, 403);
  assert.equal(await errorOf(res), "not_in_channel");
});

test("a transient Slack failure is a gateway error, not a refusal", async (t) => {
  const r = await rig(() => slackError("ratelimited"));
  t.after(() => r.close());

  const res = await fetch(`${r.url}/api/messages`, {
    method: "POST",
    headers: { [PEER_TAGS_HEADER]: HEARTH_TAG, "content-type": "application/json" },
    body: JSON.stringify({ channel: "C42", text: "hello" }),
  });
  assert.equal(res.status, 502);
  assert.equal(await errorOf(res), "ratelimited");
});

test("posting requires identity and a well-formed body", async (t) => {
  const r = await rig();
  t.after(() => r.close());

  const anonymous = await fetch(`${r.url}/api/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ channel: "C42", text: "hi" }),
  });
  assert.equal(anonymous.status, 403);

  const empty = await fetch(`${r.url}/api/messages`, {
    method: "POST",
    headers: { [PEER_TAGS_HEADER]: HEARTH_TAG, "content-type": "application/json" },
    body: JSON.stringify({ channel: "C42" }),
  });
  assert.equal(empty.status, 400);
  assert.match(await errorOf(empty), /text is required/);
  assert.equal(r.upstream.calls.length, 0, "Slack was never called");
});

test("an upload walks the external flow and lands in the named channel", async (t) => {
  const responses = [
    slackOk({ upload_url: "https://files.slack.com/upload/abc", file_id: "F77" }),
    new Response("OK", { status: 200 }),
    slackOk({ files: [{ id: "F77" }] }),
  ];
  const r = await rig(() => responses.shift()!);
  t.after(() => r.close());

  const res = await fetch(
    `${r.url}/api/files?channel=C42&filename=report.csv&comment=here+you+go`,
    {
      method: "POST",
      headers: { [PEER_TAGS_HEADER]: HEARTH_TAG, "content-type": "application/octet-stream" },
      body: Buffer.from("a,b\n1,2\n"),
    },
  );
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, file_id: "F77", channel: "C42" });
  assert.deepEqual(
    r.upstream.calls.map((call) => call.url),
    [
      "https://slack.com/api/files.getUploadURLExternal",
      "https://files.slack.com/upload/abc",
      "https://slack.com/api/files.completeUploadExternal",
    ],
  );
});

test("an upload into a foreign channel is refused at the completion step", async (t) => {
  const responses = [
    slackOk({ upload_url: "https://files.slack.com/upload/abc", file_id: "F77" }),
    new Response("OK", { status: 200 }),
    slackError("not_in_channel"),
  ];
  const r = await rig(() => responses.shift()!);
  t.after(() => r.close());

  const res = await fetch(`${r.url}/api/files?channel=C99&filename=report.csv`, {
    method: "POST",
    headers: { [PEER_TAGS_HEADER]: HEARTH_TAG, "content-type": "application/octet-stream" },
    body: Buffer.from("bytes"),
  });
  assert.equal(res.status, 403);
  assert.equal(await errorOf(res), "not_in_channel");
});

test("an empty upload body is rejected before Slack is involved", async (t) => {
  const r = await rig();
  t.after(() => r.close());

  const res = await fetch(`${r.url}/api/files?channel=C42&filename=report.csv`, {
    method: "POST",
    headers: { [PEER_TAGS_HEADER]: HEARTH_TAG, "content-type": "application/octet-stream" },
  });
  assert.equal(res.status, 400);
  assert.equal(r.upstream.calls.length, 0);
});

test("the body is piped, not buffered", async (t) => {
  // A body that never ends until released: if the surface buffered, the
  // response headers would not arrive until it did.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chunks = Readable.from(
    (async function* () {
      yield Buffer.from("first ");
      await gate;
      yield Buffer.from("second");
    })(),
  );
  const r = await rig(
    () =>
      new Response(Readable.toWeb(chunks) as unknown as ReadableStream, {
        status: 200,
        headers: { "content-length": "12" },
      }),
  );
  t.after(() => r.close());
  recordHearthFile(r.state);

  const res = await fetch(`${r.url}/files/F1`, {
    headers: { [PEER_TAGS_HEADER]: HEARTH_TAG },
  });
  assert.equal(res.status, 200, "headers arrive before the body completes");
  assert.equal(res.headers.get("content-length"), "12");
  const reader = res.body!.getReader();
  const first = await reader.read();
  assert.equal(Buffer.from(first.value!).toString(), "first ");
  release();
  const second = await reader.read();
  assert.equal(Buffer.from(second.value!).toString(), "second");
});

// ------------------------------------------------------------- read routes

function slackJson(body: Record<string, unknown>): Response {
  return Response.json({ ok: true, ...body });
}

test("channel history comes back trimmed, paged, and on the agent's own token", async (t) => {
  const r = await rig(() =>
    slackJson({
      messages: [
        {
          ts: "2.2",
          user: "U1",
          text: "release notes are out",
          reply_count: 3,
          blocks: [{ huge: "payload" }],
          team: "T1",
          files: [{ id: "F9", name: "notes.md", url_private: "https://secret" }],
        },
      ],
      has_more: true,
      response_metadata: { next_cursor: "cur-2" },
    }),
  );
  t.after(() => r.close());

  const res = await fetch(`${r.url}/api/history?channel=C42&limit=5000`, {
    headers: { [PEER_TAGS_HEADER]: HEARTH_TAG },
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as Record<string, unknown>;
  assert.deepEqual(body, {
    ok: true,
    messages: [
      {
        ts: "2.2",
        user: "U1",
        text: "release notes are out",
        reply_count: 3,
        files: [{ id: "F9", name: "notes.md" }],
      },
    ],
    has_more: true,
    next_cursor: "cur-2",
  });
  assert.equal(r.upstream.calls[0]!.url, "https://slack.com/api/conversations.history");
  assert.equal(r.upstream.calls[0]!.auth, "Bearer xoxb-hearth");
});

test("a history read the app is not entitled to is refused by the bridge", async (t) => {
  const r = await rig(() => slackError("not_in_channel"));
  t.after(() => r.close());

  const res = await fetch(`${r.url}/api/history?channel=C-private`, {
    headers: { [PEER_TAGS_HEADER]: HEARTH_TAG },
  });
  assert.equal(res.status, 403);
  assert.equal(await errorOf(res), "not_in_channel");

  const anonymous = await fetch(`${r.url}/api/history?channel=C42`);
  assert.equal(anonymous.status, 403);
});

test("thread replies require both coordinates", async (t) => {
  const r = await rig(() => slackJson({ messages: [] }));
  t.after(() => r.close());

  const missing = await fetch(`${r.url}/api/replies?channel=C42`, {
    headers: { [PEER_TAGS_HEADER]: HEARTH_TAG },
  });
  assert.equal(missing.status, 400);

  const ok = await fetch(`${r.url}/api/replies?channel=C42&ts=1.1`, {
    headers: { [PEER_TAGS_HEADER]: HEARTH_TAG },
  });
  assert.equal(ok.status, 200);
  assert.equal(r.upstream.calls.at(-1)!.url, "https://slack.com/api/conversations.replies");
});

test("search trims matches to what a model can act on", async (t) => {
  const r = await rig(() =>
    slackJson({
      messages: {
        total: 1,
        paging: { page: 1, pages: 1 },
        matches: [
          {
            ts: "3.3",
            channel: { id: "C42", name: "thicket-test", extra: "noise" },
            user: "U1",
            text: "found it",
            permalink: "https://slack/p3",
            blocks: [{}],
          },
        ],
      },
    }),
  );
  t.after(() => r.close());

  const res = await fetch(`${r.url}/api/search?query=release+notes`, {
    headers: { [PEER_TAGS_HEADER]: HEARTH_TAG },
  });
  const body = (await res.json()) as Record<string, unknown>;
  assert.deepEqual(body, {
    ok: true,
    total: 1,
    page: 1,
    pages: 1,
    matches: [
      {
        ts: "3.3",
        channel: { id: "C42", name: "thicket-test" },
        user: "U1",
        text: "found it",
        permalink: "https://slack/p3",
      },
    ],
  });
  assert.equal(r.upstream.calls[0]!.url, "https://slack.com/api/search.messages");
});

test("the directory routes list channels and users, deleted users dropped", async (t) => {
  const responses = [
    slackJson({
      channels: [
        { id: "C1", name: "general", is_private: false, is_member: false, topic: { value: "hq" } },
        { id: "C2", name: "sanctum", is_private: true, is_member: true, topic: { value: "" } },
      ],
    }),
    slackJson({
      members: [
        { id: "U1", name: "ivy", profile: { real_name: "Ivy Evans" } },
        { id: "U2", name: "gone", deleted: true },
        { id: "U3", name: "hearth", is_bot: true, profile: {} },
      ],
    }),
  ];
  const r = await rig(() => responses.shift()!);
  t.after(() => r.close());

  const channels = (await (
    await fetch(`${r.url}/api/channels`, { headers: { [PEER_TAGS_HEADER]: HEARTH_TAG } })
  ).json()) as { channels: unknown };
  assert.deepEqual(channels.channels, [
    { id: "C1", name: "general", is_private: false, is_member: false, topic: "hq" },
    { id: "C2", name: "sanctum", is_private: true, is_member: true },
  ]);

  const users = (await (
    await fetch(`${r.url}/api/users`, { headers: { [PEER_TAGS_HEADER]: HEARTH_TAG } })
  ).json()) as { users: unknown };
  assert.deepEqual(users.users, [
    { id: "U1", name: "ivy", real_name: "Ivy Evans" },
    { id: "U3", name: "hearth", is_bot: true },
  ]);
});
