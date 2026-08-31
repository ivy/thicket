import type { Agent } from "node:https";

import type { EngineLogger } from "./engine.js";
import { SocketModeConnection } from "./socket-mode.js";
import type { Connection } from "./supervisor.js";
import { translateSlackEvent, translateSlackInteraction } from "./translate.js";
import type { InboundEvent } from "./types.js";

/** Client lifecycle events worth a log line, in the library's own names. */
const LIFECYCLE = ["connecting", "connected", "reconnecting", "disconnecting", "disconnected"];

/**
 * How long a disrupted connection may spend recovering before we abandon
 * the client and let the supervisor build a fresh one. The library detects
 * a dead socket in seconds via its own ping loop; what it cannot bound is
 * how long its reconnect machinery spends stuck (observed: an hour). A
 * spurious abandonment costs one websocket; a stall costs a conversation.
 */
const RECOVERY_DEADLINE_MS = 60_000;

/** The subset of SocketModeClient the connection drives; fakeable in tests. */
export interface SocketishClient {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- event payloads are untyped in the library too
  on(event: string, listener: (...args: any[]) => void): unknown;
  start(): Promise<unknown>;
  disconnect(): Promise<void>;
}

export interface SlackSocketOptions {
  /** Injectable for tests; production builds a real Socket Mode client. */
  client?: SocketishClient;
  recoveryDeadlineMs?: number;
  /** The Web API leg: `apps.connections.open`, for the socket's URL. */
  fetchImpl?: typeof fetch;
  /** The socket leg. Production passes an agent that tunnels through netd. */
  agent?: Agent;
}

/**
 * Socket Mode connection for one agent app. The client underneath does not
 * reconnect — it reports a dead socket up and the supervisor builds a fresh
 * one — so this wrapper's job is to notice a socket that stops delivering
 * without closing. Once a disruption outlives the deadline the client is
 * abandoned and the supervisor starts over.
 */
export class SlackSocketConnection implements Connection {
  private readonly client: SocketishClient;
  private readonly recoveryDeadlineMs: number;
  private downHandler: ((reason: string) => void) | null = null;
  private deadline: NodeJS.Timeout | null = null;
  private downFired = false;
  private stopping = false;

  constructor(
    appToken: string,
    onEvent: (event: InboundEvent) => void,
    private readonly logger: EngineLogger = { info: () => {}, warn: () => {} },
    options: SlackSocketOptions = {},
  ) {
    this.recoveryDeadlineMs = options.recoveryDeadlineMs ?? RECOVERY_DEADLINE_MS;
    if (options.client === undefined && options.fetchImpl === undefined) {
      throw new Error("SlackSocketConnection needs a fetch for apps.connections.open");
    }
    this.client =
      options.client ??
      (new SocketModeConnection({
        appToken,
        fetchImpl: options.fetchImpl!,
        logger,
        ...(options.agent === undefined ? {} : { agent: options.agent }),
      }) as unknown as SocketishClient);
    this.client.on(
      "slack_event",
      (args: {
        ack?: () => Promise<void>;
        type?: string;
        event?: unknown;
        body?: unknown;
        retry_num?: number;
      }) => {
        void args.ack?.();
        const body = (args.body ?? {}) as Record<string, unknown> & { event?: Record<string, unknown> };
        if (args.type === "interactive" || body.type === "block_actions") {
          // A tap on something the bridge posted. Same shape-only logging
          // as an event: which element, never what the message said.
          const event = translateSlackInteraction(body);
          const actions = Array.isArray(body.actions) ? (body.actions as { action_id?: unknown }[]) : [];
          this.logger.info("slack interaction", {
            type: body.type,
            actions: actions.map((action) => String(action.action_id ?? "?")),
            acted: event?.kind ?? "ignored",
          });
          if (event !== undefined) {
            onEvent(event);
          }
          return;
        }
        const raw = (args.event ?? body.event) as Record<string, unknown> | undefined;
        if (raw === undefined) {
          return;
        }
        const event = translateSlackEvent(raw);
        // Shape, never content: enough to tell "Slack never delivered it"
        // from "we declined to act on it", which is otherwise unanswerable
        // after the fact. Age and retry count make a redelivered event —
        // one that sat out a dead socket — visible as such.
        this.logger.info("slack event", {
          type: raw.type,
          subtype: raw.subtype,
          channelType: raw.channel_type,
          files: Array.isArray(raw.files) ? raw.files.length : 0,
          acted: event?.kind ?? "ignored",
          ...(typeof args.retry_num === "number" && args.retry_num > 0
            ? { retryNum: args.retry_num }
            : {}),
          ...(typeof raw.ts === "string" && Number.isFinite(Number(raw.ts))
            ? { ageMs: Math.max(0, Math.round(Date.now() - Number(raw.ts) * 1000)) }
            : {}),
        });
        if (event !== undefined) {
          onEvent(event);
        }
      },
    );
    for (const name of LIFECYCLE) {
      this.client.on(name, () => this.logger.info("socket mode", { state: name }));
    }
    // Recovery watchdog. "close" and "error" mean the socket died — the
    // library's ping loop finds a silent one within seconds — after which
    // it must re-emerge as "connected" before the deadline.
    for (const name of ["close", "error", "reconnecting"]) {
      this.client.on(name, () => this.noteDisrupted(name));
    }
    this.client.on("connected", () => this.noteRecovered());
    this.client.on("disconnected", () => {
      this.down("socket mode client gave up reconnecting");
    });
  }

  async start(): Promise<void> {
    // The first connect can stall the same way a reconnect can (the wss
    // URL fetch hangs); an unbounded await here would wedge the
    // supervisor's slot forever. On timeout the client is abandoned and
    // the caller retries with backoff.
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.stopping = true; // silence the abandoned client's later events
        void this.client.disconnect().catch(() => {});
        reject(new Error(`socket mode did not connect within ${this.recoveryDeadlineMs}ms`));
      }, this.recoveryDeadlineMs);
      this.client.start().then(
        () => {
          clearTimeout(timer);
          resolve();
        },
        (err: unknown) => {
          clearTimeout(timer);
          reject(err instanceof Error ? err : new Error(String(err)));
        },
      );
    });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.clearDeadline();
    await this.client.disconnect();
  }

  onDown(handler: (reason: string) => void): void {
    this.downHandler = handler;
  }

  private noteDisrupted(source: string): void {
    if (this.stopping || this.downFired || this.deadline !== null) {
      return;
    }
    this.deadline = setTimeout(() => {
      this.down(`socket did not recover within ${this.recoveryDeadlineMs}ms after ${source}`);
    }, this.recoveryDeadlineMs);
    this.deadline.unref?.();
  }

  private noteRecovered(): void {
    this.clearDeadline();
  }

  private clearDeadline(): void {
    if (this.deadline !== null) {
      clearTimeout(this.deadline);
      this.deadline = null;
    }
  }

  /**
   * Terminal for this instance: disconnect the client so it cannot linger
   * as a second live socket beside its replacement, and tell the
   * supervisor exactly once.
   */
  private down(reason: string): void {
    if (this.stopping || this.downFired) {
      return;
    }
    this.downFired = true;
    this.clearDeadline();
    this.logger.warn("abandoning socket mode connection", { reason });
    void this.client.disconnect().catch(() => {});
    this.downHandler?.(reason);
  }
}
