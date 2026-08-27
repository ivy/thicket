import test from "node:test";
import assert from "node:assert/strict";

import type { WebClient } from "@slack/web-api";

import { WebSlackApi } from "./slack-api.js";

interface Call {
  method: string;
  args: Record<string, unknown>;
}

function fakeWeb(): { web: WebClient; calls: Call[] } {
  const calls: Call[] = [];
  const web = {
    apiCall: async (method: string, args: Record<string, unknown>) => {
      calls.push({ method, args });
      return { ok: true, ts: "1724650000.000200", team_id: "T042" };
    },
    chat: {
      postMessage: async (args: Record<string, unknown>) => {
        calls.push({ method: "chat.postMessage", args });
        return { ok: true };
      },
    },
  };
  return { web: web as unknown as WebClient, calls };
}

function rig() {
  const { web, calls } = fakeWeb();
  const logged: Record<string, unknown>[] = [];
  const api = new WebSlackApi(web, { info: (_msg, fields) => logged.push(fields ?? {}) });
  return { api, calls, logged };
}

test("setStatus carries the title only when one is given", async () => {
  const r = rig();
  await r.api.setStatus("C1", "1.1", "processing", { title: "how is the machine?" });
  await r.api.setStatus("C1", "1.1", "active");
  assert.deepEqual(r.calls[0], {
    method: "agents.sessions.setStatus",
    args: { channel_id: "C1", thread_ts: "1.1", status: "processing", title: "how is the machine?" },
  });
  assert.equal("title" in r.calls[1]!.args, false);
});

test("an activity becomes one task_update chunk", async () => {
  const r = rig();
  await r.api.appendActivity("C1", "1.2", {
    id: "toolu_1",
    title: "Check memory pressure",
    status: "running",
    details: "vm_stat",
  });
  await r.api.appendActivity("C1", "1.2", { id: "toolu_1", title: "Check memory pressure", status: "failed" });
  assert.deepEqual(r.calls[0], {
    method: "chat.appendStream",
    args: {
      channel: "C1",
      ts: "1.2",
      chunks: [
        {
          type: "task_update",
          id: "toolu_1",
          title: "Check memory pressure",
          status: "in_progress",
          details: "vm_stat",
        },
      ],
    },
  });
  const chunk = (r.calls[1]!.args.chunks as Record<string, unknown>[])[0]!;
  assert.equal(chunk.status, "error");
  assert.equal("details" in chunk, false);
});

test("text appends go through chunks, like every other append", async () => {
  const r = rig();
  await r.api.appendStream("C1", "1.2", "the tide comes in");
  assert.deepEqual(r.calls[0], {
    method: "chat.appendStream",
    args: {
      channel: "C1",
      ts: "1.2",
      chunks: [{ type: "markdown_text", text: "the tide comes in" }],
    },
  });
});

test("every call is logged, nested so no argument shadows the record", async () => {
  const r = rig();
  await r.api.startStream("C1", "1.1");
  await r.api.appendStream("C1", "1.2", "the tide comes in");
  await r.api.postMessage("C1", "1.1", "secret-ish reply");
  await r.api.appendActivity("C1", "1.2", { id: "toolu_1", title: "t", status: "done" });
  await r.api.setThreadStatus("C1", "1.1", "is thinking…");
  await r.api.stopStream("C1", "1.2");

  const slack = r.logged.map((f) => f.slack as Record<string, unknown>);
  assert.deepEqual(
    slack.map((f) => f.method),
    [
      "chat.startStream",
      "chat.appendStream",
      "chat.postMessage",
      "chat.appendStream",
      "assistant.threads.setStatus",
      "chat.stopStream",
    ],
  );
  assert.ok(
    r.logged.every((f) => Object.keys(f).length === 1 && "slack" in f),
    "arguments cannot collide with the log record's own fields",
  );
  assert.deepEqual(slack[1]?.chunks, [`markdown_text:${"the tide comes in".length}`]);
  assert.equal(slack[2]?.chars, "secret-ish reply".length);
  assert.deepEqual(slack[3]?.chunks, ["toolu_1:complete"]);
  assert.ok(
    r.logged.every((f) => !JSON.stringify(f).includes("secret-ish")),
    "no message body reaches the log",
  );
});

test("a stream that comes back without a ts is an error, not a silent no-op", async () => {
  const { web, calls } = fakeWeb();
  const api = new WebSlackApi({
    ...web,
    apiCall: async () => ({ ok: true }),
  } as unknown as WebClient);
  await assert.rejects(() => api.startStream("C1", "1.1"), /returned no ts/);
  assert.equal(calls.length, 0);
});


test("a channel stream carries the recipient and team; a DM stream never does", async () => {
  const r = rig();
  await r.api.startStream("C1", "1.1", "U-human");
  await r.api.startStream("C1", "2.2", "U-human");
  await r.api.startStream("D1", "3.3", "U-human");
  await r.api.startStream("D1", "4.4");

  const methods = r.calls.map((c) => c.method);
  assert.deepEqual(
    methods,
    ["auth.test", "chat.startStream", "chat.startStream", "chat.startStream", "chat.startStream"],
    "the team id is asked for once, not per stream",
  );
  const channelStream = r.calls[1]!.args;
  assert.equal(channelStream.recipient_user_id, "U-human");
  assert.equal(channelStream.recipient_team_id, "T042");
  const dmStream = r.calls[3]!.args;
  assert.equal("recipient_user_id" in dmStream, false, "DM path stays exactly as before");
  assert.equal("recipient_team_id" in dmStream, false);
});
