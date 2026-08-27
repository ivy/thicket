import { randomUUID } from "node:crypto";

import {
  getSessionInfo,
  query,
  type Options,
  type Query,
  type SDKControlInterruptResponse,
  type SDKMessage,
  type SDKResultMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

import { PushQueue } from "./push-queue.js";
import type { SessionHandle, SessionProvider } from "./types.js";

/** The subset of query() the manager needs; injectable for tests. */
export type QueryFn = (args: {
  prompt: AsyncIterable<SDKUserMessage>;
  options: Options;
}) => Query;

export interface SessionManagerOptions {
  /** Roster harness settings for this agent. */
  harness: {
    cwd: string;
    model: string;
    sessionTtlSeconds: number;
    /** Claude Code permission mode for the session (roster default: auto). */
    permissionMode?: "default" | "acceptEdits" | "plan" | "dontAsk" | "auto";
  };
  /** Hot pool cap; least-recently-used idle sessions are evicted beyond it. */
  maxSessions?: number;
  /**
   * Exact subprocess environment. The SDK REPLACES the environment with
   * this value rather than merging, so PATH, HOME, and credentials must be
   * passed deliberately. Defaults to just PATH and HOME from this process.
   */
  env?: Record<string, string | undefined>;
  queryFn?: QueryFn;
  /** Whether a session transcript already exists (cold start: resume vs new). */
  sessionExists?: (sessionId: string) => Promise<boolean>;
  onWarning?: (message: string) => void;
  /**
   * In-process MCP servers for every session (e.g. the Slack toolbelt),
   * as a factory: an MCP server instance serves one transport, so each
   * subprocess generation needs its own. Tools named in allowedTools skip
   * the permission prompt a headless session cannot answer.
   */
  mcpServers?: () => NonNullable<Options["mcpServers"]>;
  allowedTools?: string[];
  /**
   * The agent's persona, appended to the harness's own system prompt —
   * never replacing it. A provider rather than a string so edits to the
   * roster take effect on the next session without a restart; undefined
   * means no appendix and the options are exactly as before.
   */
  personaPrompt?: () => string | undefined;
}

const DEFAULT_MAX_SESSIONS = 8;

function defaultEnv(): Record<string, string | undefined> {
  // USER/LOGNAME are required on macOS: the CLI's keychain credential
  // lookup fails without them (observed: "Not logged in" with only
  // PATH+HOME). They are identity, not secrets.
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    USER: process.env.USER,
    LOGNAME: process.env.LOGNAME,
  };
}

async function defaultSessionExists(sessionId: string): Promise<boolean> {
  try {
    // A missing session resolves undefined rather than throwing (observed
    // against @anthropic-ai/claude-agent-sdk 0.3.247), so check the value.
    const info = await getSessionInfo(sessionId);
    return info !== undefined && info !== null;
  } catch {
    return false;
  }
}

/** One live subprocess generation of a session. */
interface Generation {
  input: PushQueue<SDKUserMessage>;
  q: Query;
  abort: AbortController;
  /** Set when the manager closed this generation deliberately. */
  closing: boolean;
  pump: Promise<void>;
}

class ManagedSession implements SessionHandle {
  readonly id: string;
  /** Frames from every generation flow through this one stream. */
  readonly out = new PushQueue<SDKMessage>();
  generation: Generation | null = null;
  /** Guards concurrent sends from spawning two subprocesses. */
  spawning: Promise<Generation> | null = null;
  /** Sends awaiting a result; a session with pending work is never evicted. */
  pendingTurns = 0;
  lastActivity: number;
  ttlTimer: NodeJS.Timeout | null = null;

  constructor(
    id: string,
    private readonly manager: SessionManager,
  ) {
    this.id = id;
    this.lastActivity = Date.now();
  }

  get frames(): AsyncIterable<SDKMessage> {
    return this.out;
  }

  get busy(): boolean {
    return this.pendingTurns > 0;
  }

  async send(message: SDKUserMessage): Promise<void> {
    const generation = await this.manager.ensureGeneration(this);
    if (message.shouldQuery !== false) {
      this.pendingTurns += 1;
    }
    this.manager.touch(this);
    generation.input.push(message);
  }

  async interrupt(options?: {
    cancelQueued?: boolean;
  }): Promise<SDKControlInterruptResponse | undefined> {
    void options; // this SDK's interrupt() takes no arguments yet
    if (this.generation === null) {
      return undefined;
    }
    this.manager.touch(this);
    return this.generation.q.interrupt();
  }
}

/**
 * Hot/cold Claude Code session pool. A session's subprocess stays alive
 * for the roster's sessionTtlSeconds after its last activity, then exits;
 * the next message resumes from the derived session ID. One stable
 * SessionHandle per contextId spans process generations, so the executor
 * (task 005) never sees an eviction.
 */
export class SessionManager implements SessionProvider {
  private readonly harness: SessionManagerOptions["harness"];
  private readonly maxSessions: number;
  private readonly env: Record<string, string | undefined>;
  private readonly queryFn: QueryFn;
  private readonly sessionExists: (sessionId: string) => Promise<boolean>;
  private readonly onWarning: (message: string) => void;
  private readonly mcpServers: (() => NonNullable<Options["mcpServers"]>) | undefined;
  private readonly allowedTools: string[] | undefined;
  private readonly personaPrompt: (() => string | undefined) | undefined;

  /** Insertion order is recency order: oldest first. */
  private readonly sessions = new Map<string, ManagedSession>();
  private shutdownRequested = false;
  private signalHandler: (() => void) | null = null;

  constructor(options: SessionManagerOptions) {
    this.harness = options.harness;
    this.maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
    this.env = options.env ?? defaultEnv();
    this.queryFn = options.queryFn ?? ((args) => query(args));
    this.sessionExists = options.sessionExists ?? defaultSessionExists;
    this.onWarning = options.onWarning ?? (() => {});
    this.mcpServers = options.mcpServers;
    this.allowedTools = options.allowedTools;
    this.personaPrompt = options.personaPrompt;
  }

  sessionFor(contextId: string): SessionHandle {
    return this.session(contextId);
  }

  /** Number of sessions with a live subprocess. */
  get hotCount(): number {
    let n = 0;
    for (const session of this.sessions.values()) {
      if (session.generation !== null) {
        n += 1;
      }
    }
    return n;
  }

  /** The live Query for a context, if hot. Exposed for process-identity tests. */
  currentQuery(contextId: string): Query | undefined {
    return this.sessions.get(contextId)?.generation?.q;
  }

  /** Terminate every pooled subprocess and end every session stream. */
  async shutdown(): Promise<void> {
    this.shutdownRequested = true;
    const pumps: Promise<void>[] = [];
    for (const session of this.sessions.values()) {
      if (session.ttlTimer !== null) {
        clearTimeout(session.ttlTimer);
        session.ttlTimer = null;
      }
      const generation = session.generation;
      if (generation !== null) {
        generation.closing = true;
        generation.input.close();
        generation.abort.abort();
        pumps.push(generation.pump);
      }
      session.out.close();
    }
    await Promise.allSettled(pumps);
    this.sessions.clear();
  }

  /**
   * Terminate pooled subprocesses when the host process is told to exit,
   * so no CLI processes are orphaned.
   */
  installSignalHandlers(target: NodeJS.Process = process): void {
    if (this.signalHandler !== null) {
      return;
    }
    this.signalHandler = () => {
      void this.shutdown();
    };
    target.once("SIGTERM", this.signalHandler);
    target.once("SIGINT", this.signalHandler);
  }

  private session(contextId: string): ManagedSession {
    let session = this.sessions.get(contextId);
    if (session === undefined) {
      session = new ManagedSession(contextId, this);
      this.sessions.set(contextId, session);
    }
    return session;
  }

  /** Marks activity: refreshes both LRU position and the idle TTL timer. */
  touch(session: ManagedSession): void {
    session.lastActivity = Date.now();
    this.sessions.delete(session.id);
    this.sessions.set(session.id, session);
    this.armTtl(session);
  }

  private armTtl(session: ManagedSession): void {
    if (session.ttlTimer !== null) {
      clearTimeout(session.ttlTimer);
    }
    if (session.generation === null || this.shutdownRequested) {
      session.ttlTimer = null;
      return;
    }
    const ttlMs = this.harness.sessionTtlSeconds * 1000;
    session.ttlTimer = setTimeout(() => {
      session.ttlTimer = null;
      this.onTtlExpired(session);
    }, ttlMs);
    session.ttlTimer.unref?.();
  }

  private onTtlExpired(session: ManagedSession): void {
    if (session.generation === null) {
      return;
    }
    if (session.busy) {
      // Never evict mid-turn: re-arm and evict after the turn settles
      // (frame observation re-checks via touch on the result).
      this.armTtl(session);
      return;
    }
    this.evict(session);
  }

  /** Close the generation and let the process exit; keep only the ID. */
  private evict(session: ManagedSession): void {
    const generation = session.generation;
    if (generation === null) {
      return;
    }
    generation.closing = true;
    session.generation = null;
    generation.input.close();
    if (session.ttlTimer !== null) {
      clearTimeout(session.ttlTimer);
      session.ttlTimer = null;
    }
  }

  async ensureGeneration(session: ManagedSession): Promise<Generation> {
    if (this.shutdownRequested) {
      throw new Error("session manager is shut down");
    }
    if (session.generation !== null) {
      return session.generation;
    }
    if (session.spawning !== null) {
      return session.spawning;
    }
    session.spawning = this.spawnGeneration(session).finally(() => {
      session.spawning = null;
    });
    return session.spawning;
  }

  private async spawnGeneration(session: ManagedSession): Promise<Generation> {
    this.enforcePoolCap();

    const persona = this.personaPrompt?.();
    const exists = await this.sessionExists(session.id);
    const input = new PushQueue<SDKUserMessage>();
    const abort = new AbortController();
    const options: Options = {
      cwd: this.harness.cwd,
      model: this.harness.model,
      env: this.env,
      includePartialMessages: true,
      abortController: abort,
      ...(this.harness.permissionMode !== undefined
        ? { permissionMode: this.harness.permissionMode }
        : {}),
      ...(this.mcpServers === undefined ? {} : { mcpServers: this.mcpServers() }),
      ...(this.allowedTools === undefined ? {} : { allowedTools: this.allowedTools }),
      // Appended to the claude_code preset, never replacing it: the
      // harness's own prompt is what makes Claude Code work at all.
      ...(persona === undefined || persona === ""
        ? {}
        : { systemPrompt: { type: "preset" as const, preset: "claude_code" as const, append: persona } }),
      ...(exists ? { resume: session.id } : { sessionId: session.id }),
    };
    const q = this.queryFn({ prompt: input, options });
    const generation: Generation = {
      input,
      q,
      abort,
      closing: false,
      pump: Promise.resolve(),
    };
    generation.pump = this.pump(session, generation);
    session.generation = generation;
    this.touch(session);
    return generation;
  }

  /**
   * Drains one generation's frames into the session's stable stream. On an
   * unexpected exit mid-turn, a synthetic error result is injected so the
   * translator fails the turn instead of hanging it; the session stays
   * resumable either way.
   */
  private async pump(session: ManagedSession, generation: Generation): Promise<void> {
    try {
      for await (const frame of generation.q) {
        if (frame.type === "result") {
          session.pendingTurns = (frame as SDKResultMessage).queued_turn_count ?? 0;
        }
        this.touch(session);
        session.out.push(frame);
      }
      if (!generation.closing && session.busy) {
        this.failPendingTurn(session, "claude code process exited before finishing the turn");
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      if (!generation.closing) {
        this.onWarning(`session ${session.id}: subprocess stream failed: ${detail}`);
        if (session.busy) {
          this.failPendingTurn(session, `claude code process crashed: ${detail}`);
        }
      }
    } finally {
      if (session.generation === generation) {
        session.generation = null;
      }
      session.pendingTurns = 0;
    }
  }

  private failPendingTurn(session: ManagedSession, reason: string): void {
    const synthetic = {
      type: "result",
      subtype: "error_during_execution",
      duration_ms: 0,
      duration_api_ms: 0,
      is_error: true,
      num_turns: 0,
      stop_reason: null,
      total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
      modelUsage: {},
      permission_denials: [],
      errors: [reason],
      queued_turn_count: 0,
      uuid: randomUUID(),
      session_id: session.id,
    } as unknown as SDKMessage;
    session.pendingTurns = 0;
    session.out.push(synthetic);
  }

  /** Beyond the cap, evict the least-recently-used idle session. */
  private enforcePoolCap(): void {
    if (this.hotCount < this.maxSessions) {
      return;
    }
    for (const session of this.sessions.values()) {
      if (session.generation !== null && !session.busy) {
        this.evict(session);
        if (this.hotCount < this.maxSessions) {
          return;
        }
      }
    }
    // Every hot session is mid-turn: run over cap rather than refuse work.
    this.onWarning(
      `session pool over cap (${this.hotCount} >= ${this.maxSessions}) with all sessions busy`,
    );
  }
}
