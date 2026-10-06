import { EventEmitter } from "node:events";
import type { Agent } from "node:https";

// Not "ws": Bun ships its own, the built-in wins over the installed package
// for the bare specifier, and it ignores the `agent` option outright — a
// socket told to go through netd would quietly go straight out instead. The
// alias is a specifier Bun has no built-in for. See spikes/bridge-egress/.
import WebSocket from "discord-ws";

import type { EngineLogger } from "./types.js";

const GATEWAY_VERSION = 10;

/** Gateway opcodes this client speaks. https://docs.discord.com/developers/events/gateway */
const OP = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  PRESENCE_UPDATE: 3,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
} as const;

/** The intents the turn table needs, and nothing it does not. */
export const INTENTS = {
  GUILDS: 1 << 0,
  GUILD_MESSAGES: 1 << 9,
  DIRECT_MESSAGES: 1 << 12,
  MESSAGE_CONTENT: 1 << 15,
} as const;

export const BRIDGE_INTENTS =
  INTENTS.GUILDS | INTENTS.GUILD_MESSAGES | INTENTS.DIRECT_MESSAGES | INTENTS.MESSAGE_CONTENT;

/**
 * Close codes after which a retry cannot help: a bad token, a sharding
 * mistake, or intents the portal has not granted. The connection reports
 * them as fatal and the supervisor leaves that agent down rather than
 * burning the identify budget on a failure that will repeat.
 */
const FATAL_CLOSE = new Set([4004, 4010, 4011, 4012, 4013, 4014]);

/**
 * Close codes that end the session as well as the socket: Discord says to
 * reconnect and identify afresh. Everything else keeps the session, and
 * the next connection resumes it.
 */
const SESSION_ENDING_CLOSE = new Set([4007, 4009]);

/** The code a client close uses: 1000 and 1001 would invalidate the session. */
const CLIENT_CLOSE = 4000;

/**
 * What a resumed connection needs to pick a session back up. The bot's own
 * user id rides along because a resume never replays READY, and without it
 * the loop guard and the mention test would not know who the bot is.
 */
export interface GatewaySession {
  sessionId: string;
  resumeUrl: string;
  seq: number | null;
  userId: string;
}

/**
 * Where the session lives between connections — and between bridge
 * processes, which is the point: a restart that identifies afresh replays
 * nothing, and the messages sent while it was down are lost.
 */
export interface SessionStore {
  load(): GatewaySession | undefined;
  save(session: GatewaySession): void;
  clear(): void;
}

export interface GatewayOptions {
  token: string;
  intents?: number;
  /** `GET /gateway/bot`, for the connect URL. Production passes a fetch that leaves through netd. */
  fetchImpl: typeof fetch;
  /** The socket leg. Production passes an agent that tunnels through netd. */
  agent?: Agent;
  sessions: SessionStore;
  /**
   * Every dispatch, in order, awaited before the sequence it carries is
   * persisted: delivery is at least once, so a crash while the handler runs
   * redelivers the dispatch on resume rather than losing it. The handler
   * records the message id, which is how a redelivery is told apart.
   */
  onDispatch: (type: string, data: unknown) => Promise<void>;
  logger?: EngineLogger;
  apiUrl?: string;
}

interface Frame {
  op: number;
  d?: unknown;
  s?: number | null;
  t?: string | null;
}

interface Ready {
  session_id: string;
  resume_gateway_url: string;
  user: { id: string; username: string };
}

/**
 * One Gateway connection for one agent. It identifies or resumes, keeps the
 * heartbeat, and delivers dispatches; it reconnects for nothing. A socket
 * that ends is reported up with whether the session survived it, and the
 * supervisor builds a fresh connection, which resumes if it did.
 *
 * Heartbeat state is this instance's and nothing else's. A timer shared
 * across connections beats on a dead socket, never sees an ack, and then
 * terminates the live one as a zombie.
 */
export class GatewayConnection extends EventEmitter {
  private readonly options: GatewayOptions;
  private socket: WebSocket | null = null;
  private firstBeat: NodeJS.Timeout | null = null;
  private beat: NodeJS.Timeout | null = null;
  private awaitingAck = false;
  private seq: number | null = null;
  private resuming = false;
  private closed = false;
  /** Dispatches are handled one at a time, in arrival order. */
  private chain: Promise<void> = Promise.resolve();
  /** The bot's own user id, from READY; what the loop guard compares against. */
  selfId: string | undefined;

  constructor(options: GatewayOptions) {
    super();
    this.options = options;
  }

  /** Resolves once READY or RESUMED has arrived; rejects if the socket ends first. */
  async start(): Promise<void> {
    const session = this.options.sessions.load();
    this.resuming = session !== undefined;
    this.seq = session?.seq ?? null;
    this.selfId = session?.userId;
    const base = session?.resumeUrl ?? (await this.gatewayUrl());
    const url = `${base}${base.includes("?") ? "&" : "?"}v=${GATEWAY_VERSION}&encoding=json`;
    this.options.logger?.info("gateway connecting", {
      host: new URL(url).host,
      resume: this.resuming,
    });
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(url, { agent: this.options.agent });
      this.socket = socket;
      let up = false;
      const ready = () => {
        if (!up) {
          up = true;
          resolve();
        }
      };
      socket.on("message", (data: unknown) => {
        const frame = this.parse(data);
        if (frame !== undefined) {
          this.onFrame(socket, frame, ready);
        }
      });
      socket.on("error", (err: Error) => {
        this.options.logger?.warn("gateway socket error", { err: err.message });
        if (!up) {
          reject(err);
        }
      });
      socket.on("close", (code: number, reason: Buffer) => {
        this.onClose(code, reason.toString());
        if (!up) {
          reject(new Error(`gateway closed before ready: ${code} ${reason.toString()}`));
        }
      });
    });
  }

  /** A clean end, by us. The session is kept for the next connection. */
  async stop(): Promise<void> {
    this.closed = true;
    this.stopBeat();
    this.socket?.close(CLIENT_CLOSE, "bridge stopping");
    this.socket = null;
  }

  /** Update the bot's presence; a custom status is `type: 4` with `state` as the text. */
  setPresence(presence: { status: string; activities: unknown[] }): void {
    this.send({ op: OP.PRESENCE_UPDATE, d: { since: null, afk: false, ...presence } });
  }

  private async gatewayUrl(): Promise<string> {
    const response = await this.options.fetchImpl(
      `${this.options.apiUrl ?? "https://discord.com/api/v10"}/gateway/bot`,
      { headers: { authorization: `Bot ${this.options.token}` } },
    );
    const body = (await response.json()) as {
      url?: string;
      session_start_limit?: { remaining?: number; total?: number };
      message?: string;
    };
    if (!response.ok || typeof body.url !== "string") {
      throw new Error(`GET /gateway/bot failed: ${body.message ?? `http ${response.status}`}`);
    }
    // Identifies are budgeted per day; the count is the only warning of a
    // reconnect loop spending it.
    this.options.logger?.info("gateway identify budget", {
      remaining: body.session_start_limit?.remaining,
      total: body.session_start_limit?.total,
    });
    return body.url;
  }

  private onFrame(socket: WebSocket, frame: Frame, ready: () => void): void {
    if (typeof frame.s === "number") {
      this.seq = frame.s;
    }
    switch (frame.op) {
      case OP.HELLO: {
        const interval = (frame.d as { heartbeat_interval: number }).heartbeat_interval;
        this.startBeat(socket, interval);
        if (this.resuming) {
          const session = this.options.sessions.load()!;
          this.send({
            op: OP.RESUME,
            d: { token: this.options.token, session_id: session.sessionId, seq: this.seq },
          });
        } else {
          this.send({
            op: OP.IDENTIFY,
            d: {
              token: this.options.token,
              intents: this.options.intents ?? BRIDGE_INTENTS,
              properties: { os: process.platform, browser: "thicket", device: "thicket" },
            },
          });
        }
        return;
      }
      case OP.HEARTBEAT_ACK:
        this.awaitingAck = false;
        return;
      case OP.HEARTBEAT:
        this.send({ op: OP.HEARTBEAT, d: this.seq });
        return;
      case OP.RECONNECT:
        // Discord asking for a fresh socket; the session is fine.
        this.options.logger?.info("gateway reconnect requested");
        socket.close(CLIENT_CLOSE, "reconnect requested");
        return;
      case OP.INVALID_SESSION:
        if (frame.d !== true) {
          this.options.logger?.warn("gateway session invalid; next connection identifies afresh");
          this.options.sessions.clear();
        }
        socket.close(CLIENT_CLOSE, "invalid session");
        return;
      case OP.DISPATCH:
        this.onDispatchFrame(frame.t ?? "", frame.d, frame.s ?? null, ready);
        return;
      default:
        return;
    }
  }

  private onDispatchFrame(type: string, data: unknown, seq: number | null, ready: () => void): void {
    if (type === "READY" || type === "RESUMED") {
      this.onSessionDispatch(type, data, ready);
      return;
    }
    // The sequence is what a resume replays from, and it is recorded only
    // once the handler has finished with the dispatch; see onDispatch.
    this.chain = this.chain.then(async () => {
      try {
        await this.options.onDispatch(type, data);
      } catch (err) {
        // The sequence stays where it was, so the next resume replays this
        // dispatch: a handler that threw gets another chance rather than
        // the message being lost.
        this.options.logger?.warn("dispatch handler failed; left for redelivery", { type, err: String(err) });
        return;
      }
      if (seq === null) {
        return;
      }
      const session = this.options.sessions.load();
      if (session !== undefined && session.seq !== seq) {
        this.options.sessions.save({ ...session, seq });
      }
    });
  }

  private onSessionDispatch(type: string, data: unknown, ready: () => void): void {
    if (type === "READY") {
      const d = data as Ready;
      this.selfId = d.user.id;
      this.options.sessions.save({
        sessionId: d.session_id,
        resumeUrl: d.resume_gateway_url,
        seq: this.seq,
        userId: d.user.id,
      });
      this.options.logger?.info("gateway ready", {
        user: d.user.id,
        resumeHost: new URL(d.resume_gateway_url).host,
      });
      this.emit("ready");
      ready();
      return;
    }
    // RESUMED carries a sequence of its own, and nothing is in flight for
    // it, so it is recorded at once.
    const session = this.options.sessions.load();
    if (session !== undefined && this.seq !== null && session.seq !== this.seq) {
      this.options.sessions.save({ ...session, seq: this.seq });
    }
    this.options.logger?.info("gateway resumed");
    this.resuming = false;
    this.emit("resumed");
    ready();
  }

  private onClose(code: number, reason: string): void {
    this.stopBeat();
    this.socket = null;
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (SESSION_ENDING_CLOSE.has(code)) {
      this.options.sessions.clear();
    }
    const fatal = FATAL_CLOSE.has(code);
    this.options.logger?.warn("gateway closed", { code, reason, fatal });
    this.emit("close", { code, reason, fatal });
  }

  private startBeat(socket: WebSocket, interval: number): void {
    this.stopBeat();
    this.awaitingAck = false;
    // The first beat waits a random fraction of the interval, as the docs
    // ask, so a fleet reconnecting together does not beat together.
    this.firstBeat = setTimeout(() => {
      this.firstBeat = null;
      this.sendBeat(socket);
      this.beat = setInterval(() => {
        if (this.awaitingAck) {
          // No ack since the last beat: the socket is a zombie, and the
          // docs say to close it with a non-1000 code and resume.
          this.options.logger?.warn("gateway heartbeat unacknowledged; closing to resume");
          socket.terminate();
          return;
        }
        this.sendBeat(socket);
      }, interval);
      this.beat.unref?.();
    }, interval * Math.random());
    this.firstBeat.unref?.();
  }

  private sendBeat(socket: WebSocket): void {
    if (socket.readyState !== WebSocket.OPEN) {
      return;
    }
    socket.send(JSON.stringify({ op: OP.HEARTBEAT, d: this.seq }));
    this.awaitingAck = true;
  }

  private stopBeat(): void {
    if (this.firstBeat !== null) {
      clearTimeout(this.firstBeat);
      this.firstBeat = null;
    }
    if (this.beat !== null) {
      clearInterval(this.beat);
      this.beat = null;
    }
  }

  private send(frame: Frame): void {
    if (this.socket === null || this.socket.readyState !== WebSocket.OPEN) {
      this.options.logger?.warn("gateway send dropped, socket not open", { op: frame.op });
      return;
    }
    this.socket.send(JSON.stringify(frame));
  }

  private parse(data: unknown): Frame | undefined {
    try {
      return JSON.parse(String(data)) as Frame;
    } catch {
      this.options.logger?.warn("gateway: unparseable frame", { bytes: String(data).length });
      return undefined;
    }
  }
}
