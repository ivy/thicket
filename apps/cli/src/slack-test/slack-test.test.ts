import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { SlackApiError, SlackTestClient } from "./client.js";
import { buildSlackTestServer } from "./server.js";

interface Call {
  method: string;
  params: Record<string, string>;
}

/** A Slack stand-in that answers by method name. */
function fakeSlack(responses: Record<string, unknown | (() => unknown)>) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const target = String(url);
    if (!target.startsWith("https://slack.com/api/")) {
      calls.push({ method: "UPLOAD", params: { url: target } });
      return new Response("", { status: 200 });
    }
    const method = target.slice("https://slack.com/api/".length);
    const params = Object.fromEntries(new URLSearchParams(String(init?.body ?? "")));
    calls.push({ method, params });
    const entry = responses[method];
    if (entry === undefined) {
      return new Response(JSON.stringify({ ok: false, error: "unknown_method" }));
    }
    const body = typeof entry === "function" ? (entry as () => unknown)() : entry;
    return new Response(JSON.stringify(body));
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function client(responses: Record<string, unknown | (() => unknown)>) {
  const { fetchImpl, calls } = fakeSlack(responses);
  return { client: new SlackTestClient({ token: "xoxp-test", fetchImpl }), calls };
}

// ------------------------------------------------------------------ client

test("a Slack error surfaces its code rather than an empty result", async () => {
  const r = client({ "auth.test": { ok: false, error: "invalid_auth" } });
  await assert.rejects(() => r.client.whoami(), (err: unknown) => {
    assert.ok(err instanceof SlackApiError);
    assert.equal(err.code, "invalid_auth");
    return true;
  });
});

test("the token travels in the header, never in the body", async () => {
  const { fetchImpl, calls } = fakeSlack({ "auth.test": { ok: true, user_id: "U1", team: "T1" } });
  let sawAuthHeader = "";
  const spying = (async (url: string | URL, init?: RequestInit) => {
    sawAuthHeader = new Headers(init?.headers).get("authorization") ?? "";
    return fetchImpl(url as string, init);
  }) as unknown as typeof fetch;
  await new SlackTestClient({ token: "xoxp-secret", fetchImpl: spying }).whoami();
  assert.equal(sawAuthHeader, "Bearer xoxp-secret");
  assert.ok(
    calls.every((call) => !Object.values(call.params).includes("xoxp-secret")),
    "no token in any form body",
  );
});

test("an agent's DM is resolved from its bot user, not hardcoded", async () => {
  const r = client({
    "users.list": {
      ok: true,
      members: [
        { id: "U9", name: "someone", is_bot: false },
        { id: "B7", name: "hearth", is_bot: true },
      ],
    },
    "conversations.open": { ok: true, channel: { id: "D42" } },
  });
  assert.equal(await r.client.dmChannelFor("hearth"), "D42");
  assert.equal(r.calls.at(-1)?.params.users, "B7");
});

test("a missing bot user says what to check", async () => {
  const r = client({ "users.list": { ok: true, members: [] } });
  await assert.rejects(() => r.client.dmChannelFor("hearth"), /is the app installed/);
});

test("channel lookup pages until it finds the name", async () => {
  let page = 0;
  const r = client({
    "conversations.list": () => {
      page += 1;
      return page === 1
        ? { ok: true, channels: [{ id: "C1", name: "general" }], response_metadata: { next_cursor: "c2" } }
        : { ok: true, channels: [{ id: "C2", name: "thicket-test" }] };
    },
  });
  assert.equal(await r.client.channelIdFor("#thicket-test"), "C2");
  assert.equal(r.calls.length, 2);
  assert.equal(r.calls[1]?.params.cursor, "c2");
});

test("upload uses the external flow and completes it", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "slacktest-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "report.csv");
  writeFileSync(path, "a,b\n1,2\n");

  const r = client({
    "files.getUploadURLExternal": { ok: true, upload_url: "https://files.slack.com/upload/x", file_id: "F1" },
    "files.completeUploadExternal": { ok: true },
  });
  const id = await r.client.upload("D42", "report.csv", new TextEncoder().encode("a,b\n1,2\n"));
  assert.equal(id, "F1");
  assert.deepEqual(
    r.calls.map((c) => c.method),
    ["files.getUploadURLExternal", "UPLOAD", "files.completeUploadExternal"],
  );
  assert.equal(r.calls[0]?.params.length, "8");
  assert.equal(r.calls[2]?.params.channel_id, "D42");
});

// ------------------------------------------------------------------ server

/** Drives the server the way a real MCP client would, over a linked pair. */
async function connect(
  deps: Parameters<typeof buildSlackTestServer>[0],
): Promise<{ call: (name: string, args: Record<string, unknown>) => Promise<Result>; close: () => Promise<void> }> {
  const server = buildSlackTestServer(deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  return {
    call: async (name, args) => (await client.callTool({ name, arguments: args })) as Result,
    close: () => client.close(),
  };
}

interface Result {
  isError?: boolean;
  content: { type: string; text?: string }[];
}

function textOf(result: Result): string {
  return result.content.map((c) => c.text ?? "").join("");
}

test("the harness exposes the tools a live test needs", async (t) => {
  const r = client({});
  const server = buildSlackTestServer({ client: r.client });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const mcp = new Client({ name: "test", version: "0.0.0" });
  await mcp.connect(clientTransport);
  t.after(() => mcp.close());
  const tools = await mcp.listTools();
  assert.deepEqual(
    tools.tools.map((tool) => tool.name).sort(),
    [
      "slack_await_reply",
      "slack_dm_agent",
      "slack_history",
      "slack_post",
      "slack_reactions",
      "slack_thread",
      "slack_upload",
      "slack_whoami",
    ],
  );
});

test("await_reply returns the agent's answer with its block structure", async () => {
  let polls = 0;
  const r = client({
    "conversations.replies": () => {
      polls += 1;
      return polls < 3
        ? { ok: true, messages: [{ ts: "1.0", user: "U1", text: "hello?" }] }
        : {
            ok: true,
            messages: [
              { ts: "1.0", user: "U1", text: "hello?" },
              {
                ts: "2.0",
                bot_id: "B7",
                text: "the tide comes in at 6pm",
                blocks: [{ type: "rich_text" }],
              },
            ],
          };
    },
  });
  const mcp = await connect({ client: r.client, sleep: async () => {}, now: () => 0 });
  const out = await mcp.call("slack_await_reply", { channel: "D42", thread_ts: "1.0" });
  await mcp.close();
  assert.notEqual(out.isError, true);
  assert.match(textOf(out), /bot=B7/);
  assert.match(textOf(out), /blocks=\[rich_text\]/);
  assert.match(textOf(out), /the tide comes in at 6pm/);
});

test("await_reply ignores the operator's own message", async () => {
  const r = client({
    "conversations.replies": { ok: true, messages: [{ ts: "1.0", user: "U1", text: "hello?" }] },
  });
  let clock = 0;
  const mcp = await connect({
    client: r.client,
    sleep: async () => { clock += 10_000; },
    now: () => clock,
  });
  const out = await mcp.call("slack_await_reply", {
    channel: "D42",
    thread_ts: "1.0",
    timeout_ms: 20_000,
  });
  await mcp.close();
  assert.equal(out.isError, true);
  assert.match(textOf(out), /no agent reply/);
  assert.match(textOf(out), /bridge log/, "points at the next place to look");
});

test("a tool failure is reported to the model, not thrown", async () => {
  const r = client({ "auth.test": { ok: false, error: "token_revoked" } });
  const mcp = await connect({ client: r.client });
  const out = await mcp.call("slack_whoami", {});
  await mcp.close();
  assert.equal(out.isError, true);
  assert.match(textOf(out), /token_revoked/);
});
