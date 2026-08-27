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
