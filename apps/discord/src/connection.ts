import type { Agent } from "node:https";

import type { BridgeEngine } from "./engine.js";
import { GatewayConnection, type SessionStore } from "./gateway.js";
import type { Connection } from "./supervisor.js";
import { translateDispatch } from "./translate.js";
import type { EngineLogger } from "./types.js";

export interface AgentConnectionOptions {
  token: string;
  sessions: SessionStore;
  /** `GET /gateway/bot`; production passes a fetch that leaves through netd. */
  fetchImpl: typeof fetch;
  /** The socket leg; production passes an agent that tunnels through netd. */
  agent?: Agent;
  logger?: EngineLogger;
}

/**
 * One agent's Gateway connection, wired to its engine. Each dispatch is
 * translated and handed to the engine, and the Gateway waits for the
 * engine before recording the sequence. A socket that ends is reported to
 * the supervisor, which builds a fresh connection; a fatal end is reported
 * once and that agent stays down, because a retry cannot fix a bad token
 * or an intent the portal has not granted.
 */
export class AgentConnection implements Connection {
  private readonly gateway: GatewayConnection;
  private downHandler: ((reason: string) => void) | null = null;
  private downFired = false;
  private readonly logger: EngineLogger;

  constructor(
    private readonly engine: BridgeEngine,
    options: AgentConnectionOptions,
  ) {
    this.logger = options.logger ?? { info: () => {}, warn: () => {} };
    this.gateway = new GatewayConnection({
      token: options.token,
      fetchImpl: options.fetchImpl,
      ...(options.agent === undefined ? {} : { agent: options.agent }),
      sessions: options.sessions,
      logger: this.logger,
      onDispatch: (type, data) => this.onDispatch(type, data),
    });
    this.gateway.on("close", (info: { code: number; reason: string; fatal: boolean }) => {
      this.down(`gateway closed ${info.code} ${info.reason || "(no reason)"}${info.fatal ? " (fatal)" : ""}`, info.fatal);
    });
  }

  /** The bot's own user id, once READY has said it. */
  get selfId(): string | undefined {
    return this.gateway.selfId;
  }

  async start(): Promise<void> {
    await this.gateway.start();
  }

  async stop(): Promise<void> {
    await this.gateway.stop();
  }

  onDown(handler: (reason: string) => void): void {
    this.downHandler = handler;
  }

  /** Whether this connection ended for a reason no reconnect can fix. */
  fatal = false;

  private async onDispatch(type: string, data: unknown): Promise<void> {
    const event = translateDispatch(type, data);
    // Shape, never content: enough to tell "Discord never delivered it"
    // from "we declined to act on it", which is otherwise unanswerable
    // after the fact.
    const d = (typeof data === "object" && data !== null ? data : {}) as Record<string, unknown>;
    this.logger.info("gateway dispatch", {
      type,
      acted: event?.kind ?? "ignored",
      ...(type === "MESSAGE_CREATE"
        ? {
            messageType: d.type,
            guild: d.guild_id !== undefined,
            files: Array.isArray(d.attachments) ? d.attachments.length : 0,
            app: (d.author as { bot?: boolean } | undefined)?.bot === true || typeof d.webhook_id === "string",
          }
        : {}),
      ...(type === "INTERACTION_CREATE" ? { interactionType: d.type } : {}),
    });
    if (event === undefined) {
      return;
    }
    await this.engine.handleEvent(event);
  }

  private down(reason: string, fatal: boolean): void {
    if (this.downFired) {
      return;
    }
    this.downFired = true;
    this.fatal = fatal;
    this.downHandler?.(reason);
  }
}
