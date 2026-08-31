import { EventEmitter } from "node:events";
import type { Agent } from "node:https";

// Not "ws": Bun ships its own, the built-in wins over the installed package
// for the bare specifier, and it ignores the `agent` option outright — a
// socket told to go through netd would quietly go straight out instead. The
// alias is a specifier Bun has no built-in for. See spikes/bridge-egress/.
import WebSocket from "slack-ws";

import type { EngineLogger } from "./engine.js";

/**
 * Slack sends a ping about every thirty seconds. Twice that with nothing at
 * all — not a frame, not a ping — is a socket that has stopped delivering
 * without troubling anyone to close it, which is the failure that looks
 * healthiest from the outside.
 */
const SILENCE_TIMEOUT_MS = 70_000;

const SLACK_API_URL = "https://slack.com/api/";

export interface SocketModeOptions {
  /** App-level token (`xapp-`), which buys exactly one thing: a socket URL. */
  appToken: string;
  /** The Web API leg. Production passes a fetch that leaves through netd. */
  fetchImpl: typeof fetch;
  /** The socket leg. Production passes an agent that tunnels through netd. */
  agent?: Agent;
  logger?: EngineLogger;
  slackApiUrl?: string;
  silenceTimeoutMs?: number;
}

/** One envelope as Socket Mode delivers it. */
interface Envelope {
  envelope_id?: string;
  type?: string;
  payload?: { event?: unknown; type?: string };
  retry_attempt?: number;
}

/**
 * Socket Mode, ours.
 *
 * The library's client cannot be routed through netd under Bun — it opens
 * its socket with the bare `ws` specifier, which Bun answers with a
 * built-in that ignores the proxy agent. Owning the protocol is the way
 * through, and it is a small protocol: ask for a URL, connect, say the
 * envelope id back, and stop.
 *
 * It reconnects for nothing. A socket that dies is reported up, and the
 * supervisor builds a fresh connection with backoff it already owns — which
 * is what happened to the library's own retries anyway, after they spent an
 * hour invisible inside a Web API client.
 */
export class SocketModeConnection extends EventEmitter {
  private readonly options: Required<Pick<SocketModeOptions, "slackApiUrl" | "silenceTimeoutMs">> &
    SocketModeOptions;
  private socket: WebSocket | null = null;
  private silence: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(options: SocketModeOptions) {
    super();
    this.options = {
      ...options,
      slackApiUrl: options.slackApiUrl ?? SLACK_API_URL,
      silenceTimeoutMs: options.silenceTimeoutMs ?? SILENCE_TIMEOUT_MS,
    };
  }

  async start(): Promise<void> {
    this.emit("connecting");
    const url = await this.openConnection();
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(url, { agent: this.options.agent });
      this.socket = socket;
      let greeted = false;

      socket.on("open", () => this.touch());
      // Slack's own ping is the liveness signal; ws answers it for us, and
      // seeing it is what tells us the far end is still there.
      socket.on("ping", () => this.touch());
      socket.on("pong", () => this.touch());
      socket.on("message", (data: unknown) => {
        this.touch();
        const frame = this.parse(data);
        if (frame === undefined) {
          return;
        }
        if (frame.type === "hello") {
          if (!greeted) {
            greeted = true;
            this.emit("connected");
            resolve();
          }
          return;
        }
        if (frame.type === "disconnect") {
          // Slack asking us to go away and come back — a refresh, or its
          // own maintenance. Reported up like any other end.
          this.down("slack sent disconnect");
          return;
        }
        this.deliver(frame);
      });
      socket.on("error", (err: Error) => {
        this.emit("error", err);
        if (!greeted) {
          reject(err);
        }
        this.down(`websocket error: ${err.message}`);
      });
      socket.on("close", (code: number, reason: Buffer) => {
        this.down(`websocket closed ${code} ${reason.toString() || "(no reason)"}`);
        if (!greeted) {
          reject(new Error(`socket closed before hello: ${code}`));
        }
      });
    });
  }

  async disconnect(): Promise<void> {
    this.emit("disconnecting");
    this.closed = true;
    this.clearSilence();
    this.socket?.close();
    this.socket = null;
    this.emit("disconnected");
  }

  /**
   * `apps.connections.open` is the only thing the app-level token is for.
   * It goes through the injected fetch, so on a deployed bridge it leaves
   * the same way everything else does.
   */
  private async openConnection(): Promise<string> {
    const response = await this.options.fetchImpl(
      `${this.options.slackApiUrl}apps.connections.open`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.options.appToken}`,
          "content-type": "application/x-www-form-urlencoded; charset=utf-8",
        },
        body: "",
      },
    );
    const body = (await response.json()) as { ok?: boolean; url?: string; error?: string };
    if (body.ok !== true || typeof body.url !== "string") {
      throw new Error(
        `apps.connections.open failed: ${body.error ?? `http ${response.status}`}`,
      );
    }
    return body.url;
  }

  private parse(data: unknown): Envelope | undefined {
    try {
      return JSON.parse(String(data)) as Envelope;
    } catch {
      // Slack does not send us malformed JSON; if it ever does, the frame is
      // the evidence and dropping it silently would throw that away.
      this.options.logger?.warn("socket mode: unparseable frame", {
        bytes: String(data).length,
      });
      return undefined;
    }
  }

  /** An envelope becomes the shape the engine's translator already reads. */
  private deliver(frame: Envelope): void {
    if (frame.envelope_id === undefined) {
      return;
    }
    const envelopeId = frame.envelope_id;
    this.emit("slack_event", {
      ack: async () => this.ack(envelopeId),
      type: frame.type,
      event: frame.payload?.event,
      body: frame.payload,
      retry_num: frame.retry_attempt,
    });
  }

  private ack(envelopeId: string): void {
    // An unacknowledged envelope is redelivered, so a socket that has gone
    // means the event is not lost — it arrives again on the next one.
    if (this.socket === null || this.socket.readyState !== WebSocket.OPEN) {
      this.options.logger?.warn("socket mode: ack dropped, socket not open", { envelopeId });
      return;
    }
    this.socket.send(JSON.stringify({ envelope_id: envelopeId }));
  }

  private touch(): void {
    this.clearSilence();
    if (this.closed) {
      return;
    }
    this.silence = setTimeout(() => {
      this.down(`nothing received for ${this.options.silenceTimeoutMs}ms`);
    }, this.options.silenceTimeoutMs);
    this.silence.unref?.();
  }

  private clearSilence(): void {
    if (this.silence !== null) {
      clearTimeout(this.silence);
      this.silence = null;
    }
  }

  /** Terminal, once: the supervisor's job from here. */
  private down(reason: string): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.clearSilence();
    this.socket?.close();
    this.emit("close", reason);
  }
}
