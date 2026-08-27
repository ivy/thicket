import { SocketModeClient } from "@slack/socket-mode";

import type { EngineLogger } from "./engine.js";
import type { Connection } from "./supervisor.js";
import { translateSlackEvent } from "./translate.js";
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

type SlackLoggerOption = NonNullable<ConstructorParameters<typeof SocketModeClient>[0]>["logger"];

/**
 * Adapts the library's logger interface onto ours, so warnings like
 * "A pong wasn't received from the server" appear in the bridge's own
 * structured log instead of a bare console. Debug/info are dropped: at
 * debug the library prints every websocket payload.
 */
function libraryLogger(logger: EngineLogger): SlackLoggerOption {
  const forward = (level: string) => (...msgs: unknown[]) => {
    logger.warn("socket mode library", { level, detail: msgs.map(String).join(" ") });
  };
  return {
    debug: () => {},
    info: () => {},
    warn: forward("warn"),
    error: forward("error"),
    setLevel: () => {},
    setName: () => {},
    getLevel: () => "warn",
  } as unknown as SlackLoggerOption;
}

export interface SlackSocketOptions {
  /** Injectable for tests; production builds a real SocketModeClient. */
  client?: SocketishClient;
  recoveryDeadlineMs?: number;
}

/**
 * Socket Mode connection for one agent app. The @slack/socket-mode client
 * handles ping/pong and transparent reconnects; this wrapper watches the
 * recovery, because a socket that stops delivering looks healthy from the
 * outside while the library retries — and its retries can stall for an
 * hour inside an unbounded web API backoff. Once a disruption outlives the
 * deadline the whole client is abandoned and the supervisor starts over.
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
    this.client =
      options.client ??
      (new SocketModeClient({
        appToken,
        logger: libraryLogger(logger),
        // Bound the hidden apps.connections.open retries. The default
        // ({retries: 100, factor: 1.3}) buries reconnection inside the
        // WebClient where it is unobservable, uncancellable, and grows to
        // hour-long waits; failures should instead surface to the
        // library's own reconnect loop, which we can watch and stop.
        clientOptions: { retryConfig: { retries: 3, factor: 2 } },
      }) as unknown as SocketishClient);
    this.client.on(
      "slack_event",
      (args: {
        ack?: () => Promise<void>;
        event?: unknown;
        body?: unknown;
        retry_num?: number;
      }) => {
        void args.ack?.();
        const body = (args.body ?? {}) as { event?: Record<string, unknown> };
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
