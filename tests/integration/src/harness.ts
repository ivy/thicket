import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  Options,
  Query,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { DefaultRequestHandler } from "@a2a-js/sdk/server";
import { buildServer, SqliteTaskStore, type Logger } from "@thicket/agentd";
import { RemoteAgentClient } from "@thicket/a2a-client";
import {
  BridgeEngine,
  BridgeState,
  type AgentActivity,
  type SlackApi,
  type SlackSessionStatus,
} from "@thicket/bridge";
import { ClaudeAgentExecutor, PushQueue, SessionManager } from "@thicket/executor";
import { toAgentCard, type AgentEntry } from "@thicket/roster";

export const BRIDGE_TAG = "tag:thicket-bridge";

export function agentEntry(name: string): AgentEntry {
  return {
    host: "home",
    user: name,
    description: `${name} integration agent.`,
    tag: `tag:thicket-${name}`,
    skills: [],
    harness: {
      type: "claude-agent-sdk",
      cwd: "/tmp",
      model: "claude-opus-5",
      sessionTtlSeconds: 300,
      permissionMode: "auto",
      attachments: "accept",
    },
    context: "native",
    queueing: "harness",
    workspaces: {},
    channels: {},
    phone: { enabled: false, aliases: [], resumeWindowSeconds: 86_400 },
  };
}

export function quietLogger(): Logger {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

function textOf(message: SDKUserMessage): string {
  return typeof message.message.content === "string" ? message.message.content : "";
}

/**
 * Scripted Claude Code CLI with real coalescing semantics: messages that
 * arrive while a turn is running queue up, and the whole queue folds into
 * the next turn — one result, first queued uuid as the join key,
 * queued_turn_count reported at each result.
 */
export class CoalescingCli {
  turnsRun = 0;
  interrupts = 0;
  hold = false;
  /** Messages waiting in the CLI's queue right now. */
  queuedCount = 0;
  private releaseWaiters: (() => void)[] = [];
  private abortCurrent: (() => void) | null = null;

  release(): void {
    for (const waiter of this.releaseWaiters.splice(0)) {
      waiter();
    }
  }

  queryFn = ({ prompt, options }: { prompt: AsyncIterable<SDKUserMessage>; options: Options }): Query => {
    const sessionId = options.resume ?? options.sessionId ?? "unknown";
    const out = new PushQueue<SDKMessage>();
    options.abortController?.signal.addEventListener("abort", () => out.close());

    const queue: SDKUserMessage[] = [];
    let running = false;
    let inputDone = false;

    out.push({
      type: "system",
      subtype: "init",
      capabilities: ["interrupt_receipt_v1", "interrupt_cancel_queued_v1"],
      session_id: sessionId,
      uuid: "00000000-0000-0000-0000-00000000cafe",
    } as unknown as SDKMessage);

    const runTurn = async (): Promise<void> => {
      running = true;
      while (queue.length > 0) {
        // Coalesce: take everything queued right now into one turn.
        const batch = queue.splice(0, queue.length);
        this.queuedCount = queue.length;
        const primary = batch[0]!;
        const text = batch.map(textOf).join(" | ");
        this.turnsRun += 1;
        let aborted = false;
        out.push({
          type: "stream_event",
          event: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: `answer(${text})` },
          },
          parent_tool_use_id: null,
          user_message_uuid: primary.uuid,
          uuid: "11111111-0000-0000-0000-000000000001",
          session_id: sessionId,
        } as unknown as SDKMessage);
        if (this.hold) {
          await new Promise<void>((resolve) => {
            this.releaseWaiters.push(resolve);
            this.abortCurrent = () => {
              aborted = true;
              resolve();
            };
          });
          this.abortCurrent = null;
        }
        if (aborted) {
          out.push({
            type: "assistant",
            message: {
              id: "msg_abort",
              type: "message",
              role: "assistant",
              model: "claude-opus-5",
              content: [],
              stop_reason: null,
              usage: { input_tokens: 1, output_tokens: 1 },
            },
            parent_tool_use_id: null,
            aborted: true,
            uuid: "11111111-0000-0000-0000-00000000ab04",
            session_id: sessionId,
          } as unknown as SDKMessage);
        }
        out.push({
          type: "result",
          subtype: "success",
          duration_ms: 1,
          duration_api_ms: 1,
          is_error: false,
          num_turns: 1,
          result: aborted ? "" : `answer(${text})`,
          stop_reason: aborted ? null : "end_turn",
          total_cost_usd: 0,
          usage: { input_tokens: 1, output_tokens: 1 },
          modelUsage: {},
          permission_denials: [],
          queued_turn_count: queue.length,
          user_message_uuid: primary.uuid,
          uuid: "11111111-0000-0000-0000-000000000003",
          session_id: sessionId,
        } as unknown as SDKMessage);
      }
      running = false;
      if (inputDone) {
        out.close();
      }
    };

    void (async () => {
      for await (const message of prompt) {
        if (message.shouldQuery === false) {
          continue;
        }
        queue.push(message);
        this.queuedCount = queue.length;
        if (!running) {
          void runTurn();
        }
      }
      inputDone = true;
      if (!running) {
        out.close();
      }
    })();

    const generator = (async function* () {
      for await (const frame of out) {
        yield frame;
      }
    })();
    return Object.assign(generator, {
      interrupt: async () => {
        this.interrupts += 1;
        this.abortCurrent?.();
        return { still_queued: [], cancelled: [] };
      },
    }) as unknown as Query;
  };
}

export interface RunningAgent {
  name: string;
  url: string;
  cli: CoalescingCli;
  store: SqliteTaskStore;
  sessions: SessionManager;
  server: Server;
  dbPath: string;
  stop(): Promise<void>;
}

/** A real agentd stack: real store, executor, session pool, HTTP surface. */
export async function startAgent(
  name: string,
  options: { dbPath?: string; cli?: CoalescingCli } = {},
): Promise<RunningAgent> {
  const dir = mkdtempSync(join(tmpdir(), `thicket-${name}-`));
  const dbPath = options.dbPath ?? join(dir, "tasks.db");
  const cli = options.cli ?? new CoalescingCli();
  const store = new SqliteTaskStore(dbPath);
  store.failUnfinished("agentd restarted; the previous process and its running turn are gone.");
  const sessions = new SessionManager({
    harness: agentEntry(name).harness,
    queryFn: cli.queryFn,
    sessionExists: async () => false,
  });
  const executor = new ClaudeAgentExecutor({ sessions });
  const card = toAgentCard(name, agentEntry(name));
  const handler = new DefaultRequestHandler(card, store, executor);
  const app = buildServer({ handler, allowedPeerTags: [BRIDGE_TAG], logger: quietLogger() });
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("no address");
  }
  const url = `http://127.0.0.1:${address.port}`;
  // Clients dial the URL the card advertises. In production that is the
  // tailnet name netd answers on; here it is this test server.
  for (const iface of card.supportedInterfaces) {
    iface.url = `${url}/a2a/v1`;
  }
  return {
    name,
    url,
    cli,
    store,
    sessions,
    server,
    dbPath,
    stop: async () => {
      // Destroy open connections (SSE streams) first, or close() waits on
      // them forever.
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await sessions.shutdown();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Plays netd's role for the bridge: stamps the verified peer tag. */
export function netdFetch(tag: string = BRIDGE_TAG): typeof fetch {
  return (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set("x-thicket-peer-tags", tag);
    return fetch(input, { ...init, headers });
  };
}

export type SlackCall =
  | {
      type: "setStatus";
      channel: string;
      threadTs: string;
      status: SlackSessionStatus;
      title?: string;
    }
  | { type: "note"; channel: string; threadTs: string; status: string }
  | { type: "post"; channel: string; threadTs: string; text: string }
  | { type: "postBlocks"; channel: string; threadTs: string; text: string; blocks: unknown[]; ts: string }
  | { type: "update"; channel: string; ts: string; text: string; blocks: unknown[] }
  | { type: "startStream"; channel: string; threadTs: string; ts: string }
  | { type: "append"; channel: string; ts: string; text: string }
  | { type: "activity"; channel: string; ts: string; activity: AgentActivity }
  | { type: "stop"; channel: string; ts: string };

export class MockSlack implements SlackApi {
  calls: SlackCall[] = [];
  private streamCounter = 0;

  async setStatus(
    channel: string,
    threadTs: string,
    status: SlackSessionStatus,
    options?: { title?: string },
  ) {
    this.calls.push({ type: "setStatus", channel, threadTs, status, title: options?.title });
  }
  /** Ids the fake should call bots; everything else is a person. */
  bots = new Set<string>();
  async isBotUser(userId: string) {
    return this.bots.has(userId);
  }
  async setThreadStatus(channel: string, threadTs: string, status: string) {
    this.calls.push({ type: "note", channel, threadTs, status });
  }
  async postMessage(channel: string, threadTs: string, text: string) {
    this.calls.push({ type: "post", channel, threadTs, text });
  }
  private blocksCounter = 0;
  async postBlocks(channel: string, threadTs: string, text: string, blocks: unknown[]) {
    const ts = `blocks-${++this.blocksCounter}`;
    this.calls.push({ type: "postBlocks", channel, threadTs, text, blocks, ts });
    return ts;
  }
  async updateMessage(channel: string, ts: string, text: string, blocks: unknown[]) {
    this.calls.push({ type: "update", channel, ts, text, blocks });
  }
  async startStream(channel: string, threadTs: string) {
    const ts = `stream-${++this.streamCounter}`;
    this.calls.push({ type: "startStream", channel, threadTs, ts });
    return ts;
  }
  async appendStream(channel: string, ts: string, text: string) {
    this.calls.push({ type: "append", channel, ts, text });
  }
  async appendActivity(channel: string, ts: string, activity: AgentActivity) {
    this.calls.push({ type: "activity", channel, ts, activity });
  }
  async stopStream(channel: string, ts: string) {
    this.calls.push({ type: "stop", channel, ts });
  }
  /** Thread transcript served to replay agents; keyed `channel:threadTs`. */
  threads = new Map<string, { ts: string; authorId?: string; botId?: string; text: string }[]>();
  async replies(channel: string, threadTs: string) {
    return this.threads.get(`${channel}:${threadTs}`) ?? [];
  }
  reactions: { channel: string; ts: string; emoji: string }[] = [];
  async addReaction(channel: string, ts: string, emoji: string) {
    this.reactions.push({ channel, ts, emoji });
  }
  channelNames = new Map<string, string>();
  async channelName(channel: string) {
    return this.channelNames.get(channel);
  }
  activities(): AgentActivity[] {
    return this.calls.filter((c) => c.type === "activity").map((c) => c.activity);
  }
  statuses(): SlackSessionStatus[] {
    return this.calls.filter((c) => c.type === "setStatus").map((c) => c.status);
  }
  streamedText(): string {
    return this.calls
      .filter((c) => c.type === "append")
      .map((c) => c.text)
      .join("");
  }
}

export interface RunningBridge {
  engine: BridgeEngine;
  slack: MockSlack;
  state: BridgeState;
}

export function startBridge(agent: RunningAgent, dbPath = ":memory:"): RunningBridge {
  const slack = new MockSlack();
  const state = new BridgeState(dbPath);
  const engine = new BridgeEngine({
    agent: agent.name,
    queueing: "harness",
    client: new RemoteAgentClient(agent.url, netdFetch()),
    slack,
    state,
  });
  return { engine, slack, state };
}

export async function until(cond: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`timed out waiting for: ${what}`);
}
