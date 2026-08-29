import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildToolbelt,
  postMessage,
  resolveOrigin,
  routineTools,
  toToolResult,
  TOOLBELT_ALLOWED_TOOLS,
  uploadFile,
  type ToolbeltOptions,
} from "./toolbelt.js";
import { RoutineStore } from "./store/routines.js";

function options(
  respond: (url: string, init?: RequestInit) => Response,
  cwd = "/tmp",
): { opts: ToolbeltOptions; calls: { url: string; init?: RequestInit }[] } {
  const calls: { url: string; init?: RequestInit }[] = [];
  return {
    calls,
    opts: {
      bridgeBaseUrl: "http://bridge",
      cwd,
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), ...(init === undefined ? {} : { init }) });
        return respond(String(url), init);
      }) as typeof fetch,
    },
  };
}

test("post_message calls the bridge and reports the posted ts", async () => {
  const { opts, calls } = options(() => Response.json({ ok: true, channel: "C1", ts: "5.5" }));
  const outcome = await postMessage(opts, { channel: "C1", text: "hello" });
  assert.deepEqual(outcome, { outcome: "ok", detail: { ok: true, channel: "C1", ts: "5.5" } });
  assert.equal(calls[0]!.url, "http://bridge/api/messages");
  assert.deepEqual(JSON.parse(String(calls[0]!.init?.body)), { channel: "C1", text: "hello" });
});

test("a 403 from the bridge is a refusal the model is told not to retry", async () => {
  const { opts } = options(() => Response.json({ error: "not_in_channel" }, { status: 403 }));
  const outcome = await postMessage(opts, { channel: "C9", text: "hi" });
  assert.equal(outcome.outcome, "refused");
  const result = toToolResult(outcome);
  assert.equal(result.isError, true);
  assert.match(result.content[0]!.text, /not_in_channel/);
  assert.match(result.content[0]!.text, /Do not retry/);
});

test("an unreachable bridge is a failure, not a thrown turn", async () => {
  const { opts } = options(() => {
    throw new Error("ECONNREFUSED");
  });
  const outcome = await postMessage(opts, { channel: "C1", text: "hi" });
  assert.equal(outcome.outcome, "failed");
  const result = toToolResult(outcome);
  assert.equal(result.isError, true);
  assert.match(result.content[0]!.text, /bridge unreachable/);
});

test("upload_file resolves relative paths against the session cwd and streams the bytes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "toolbelt-"));
  writeFileSync(join(dir, "out.txt"), "generated");
  const { opts, calls } = options(
    () => Response.json({ ok: true, file_id: "F1", channel: "C1" }),
    dir,
  );
  const outcome = await uploadFile(opts, { channel: "C1", path: "out.txt", comment: "done" });
  assert.equal(outcome.outcome, "ok");
  const url = new URL(calls[0]!.url);
  assert.equal(url.pathname, "/api/files");
  assert.equal(url.searchParams.get("channel"), "C1");
  assert.equal(url.searchParams.get("filename"), "out.txt");
  assert.equal(url.searchParams.get("comment"), "done");
  assert.equal(String(calls[0]!.init?.body), "generated");
});

test("a missing upload file fails without touching the bridge", async () => {
  const { opts, calls } = options(() => Response.json({ ok: true }));
  const outcome = await uploadFile(opts, { channel: "C1", path: "/nowhere/nothing.bin" });
  assert.equal(outcome.outcome, "failed");
  assert.match((outcome as { error: string }).error, /no such file/);
  assert.equal(calls.length, 0);
});

test("the toolbelt is an in-process SDK server exposing exactly the allowed tools", () => {
  const { opts } = options(() => Response.json({ ok: true }));
  const server = buildToolbelt(opts);
  assert.equal(server.type, "sdk");
  assert.equal(server.name, "thicket");
  assert.deepEqual(TOOLBELT_ALLOWED_TOOLS, [
    "mcp__thicket__post_message",
    "mcp__thicket__upload_file",
    "mcp__thicket__react",
    "mcp__thicket__read_channel",
    "mcp__thicket__read_thread",
    "mcp__thicket__search_messages",
    "mcp__thicket__list_channels",
    "mcp__thicket__list_users",
    "mcp__thicket__schedule_once",
    "mcp__thicket__routine_create",
    "mcp__thicket__routine_list",
    "mcp__thicket__routine_update",
    "mcp__thicket__routine_delete",
  ]);
});

test("read tools GET the bridge with only the arguments that were given", async () => {
  const { readBridge } = await import("./toolbelt.js");
  const { opts, calls } = options(() => Response.json({ ok: true, messages: [] }));
  const outcome = await readBridge(opts, "/api/history", {
    channel: "C1",
    limit: 10,
    cursor: undefined,
  });
  assert.equal(outcome.outcome, "ok");
  const url = new URL(calls[0]!.url);
  assert.equal(url.pathname, "/api/history");
  assert.equal(url.searchParams.get("channel"), "C1");
  assert.equal(url.searchParams.get("limit"), "10");
  assert.equal(url.searchParams.has("cursor"), false);
  assert.equal(calls[0]!.init?.method, "GET");
});

test("a one-shot's origin comes from the bridge, keyed by the session, never from the model", async () => {
  const { opts, calls } = options(() =>
    Response.json({ ok: true, channel: "D1", thread_ts: "1.1", context_id: "ctx-1" }),
  );
  const origin = await resolveOrigin({ ...opts, contextId: "ctx-1" });
  assert.deepEqual(origin, { channel: "D1", threadTs: "1.1", contextId: "ctx-1" });
  const url = new URL(calls[0]!.url);
  assert.equal(url.pathname, "/api/origin");
  assert.equal(url.searchParams.get("context_id"), "ctx-1");

  assert.deepEqual(await resolveOrigin(opts), {
    error: "this session has no conversation to schedule from",
  });
  const refused = options(() => Response.json({ error: "no open turn in that conversation" }, { status: 403 }));
  assert.deepEqual(await resolveOrigin({ ...refused.opts, contextId: "ctx-9" }), {
    error: "no open turn in that conversation",
  });
});

test("schedule_once rejects times that are past or unreadable, and records a good one", async () => {
  const store = new RoutineStore(":memory:");
  const { opts, calls } = options(() =>
    Response.json({ ok: true, channel: "D1", thread_ts: "1.1", context_id: "ctx-1" }),
  );
  const now = Date.parse("2026-08-28T20:00:00Z");
  const tools = routineTools({ ...opts, contextId: "ctx-1", routines: store, now: () => now }, store);
  const handler = (name: string) => {
    const definition = tools.find((t) => t.name === name);
    assert.ok(definition, `${name} is offered`);
    return async (args: Record<string, unknown>) =>
      (await definition.handler(args as never, {})) as {
        isError?: boolean;
        content: { text: string }[];
      };
  };
  const call = handler("schedule_once");

  const past = await call({ at: "2026-08-28T19:00:00Z", prompt: "p" });
  assert.equal(past.isError, true);
  assert.match(past.content[0]!.text, /already past/);
  const junk = await call({ at: "tomorrow-ish", prompt: "p" });
  assert.equal(junk.isError, true);
  assert.match(junk.content[0]!.text, /not a time I can parse/);
  assert.equal(calls.length, 0, "no origin lookup for a rejected time");

  const good = await call({ at: "2026-08-29T09:00:00Z", prompt: "post the word ping" });
  assert.notEqual(good.isError, true, good.content[0]!.text);
  const body = JSON.parse(good.content[0]!.text) as { scheduled: Record<string, unknown> };
  assert.equal(body.scheduled.at, "2026-08-29T09:00:00.000Z");
  assert.equal(body.scheduled.channel, "D1");
  assert.equal(body.scheduled.thread_ts, "1.1");
  const [row] = store.list();
  assert.equal(row?.kind, "at");
  assert.equal(row?.name, "post the word ping");
  assert.deepEqual(row?.origin, { channel: "D1", threadTs: "1.1", contextId: "ctx-1" });

  const listed = await handler("routine_list")({});
  const routines = (JSON.parse(listed.content[0]!.text) as { routines: Record<string, unknown>[] }).routines;
  assert.equal(routines[0]?.kind, "at");
  assert.equal(routines[0]?.at, "2026-08-29T09:00:00.000Z");
  assert.equal(routines[0]?.fired, null);

  // A one-shot cannot be re-timed through routine_update; delete cancels it.
  const retimed = await handler("routine_update")({ id: row!.id, cron: "* * * * *" });
  assert.equal(retimed.isError, true);
  assert.match(retimed.content[0]!.text, /one-shot/);
  const deleted = await handler("routine_delete")({ id: row!.id });
  assert.notEqual(deleted.isError, true);
  assert.equal(store.list().length, 0);
  store.close();
});
