import { SocketModeClient } from "@slack/socket-mode";

import type { EngineLogger } from "./engine.js";
import type { Connection } from "./supervisor.js";
import { translateSlackEvent } from "./translate.js";
import type { InboundEvent } from "./types.js";

/** Client lifecycle events worth a log line, in the library's own names. */
const LIFECYCLE = ["connecting", "connected", "reconnecting", "disconnecting", "disconnected"];

/**
 * Socket Mode connection for one agent app. The @slack/socket-mode client
 * handles ping/pong and transparent reconnects; the supervisor only hears
 * about terminal failures.
 */
export class SlackSocketConnection implements Connection {
  private readonly client: SocketModeClient;
  private downHandler: ((reason: string) => void) | null = null;

  constructor(
    appToken: string,
    onEvent: (event: InboundEvent) => void,
    private readonly logger: EngineLogger = { info: () => {}, warn: () => {} },
  ) {
    this.client = new SocketModeClient({ appToken });
    this.client.on("slack_event", (args: { ack?: () => Promise<void>; event?: unknown; body?: unknown }) => {
      void args.ack?.();
      const body = (args.body ?? {}) as { event?: Record<string, unknown> };
      const raw = (args.event ?? body.event) as Record<string, unknown> | undefined;
      if (raw === undefined) {
        return;
      }
      const event = translateSlackEvent(raw);
      // Shape, never content: enough to tell "Slack never delivered it"
      // from "we declined to act on it", which is otherwise unanswerable
      // after the fact.
      this.logger.info("slack event", {
        type: raw.type,
        subtype: raw.subtype,
        channelType: raw.channel_type,
        files: Array.isArray(raw.files) ? raw.files.length : 0,
        acted: event?.kind ?? "ignored",
      });
      if (event !== undefined) {
        onEvent(event);
      }
    });
    for (const name of LIFECYCLE) {
      this.client.on(name, () => this.logger.info("socket mode", { state: name }));
    }
    this.client.on("disconnected", () => {
      this.downHandler?.("socket mode client gave up reconnecting");
    });
  }

  async start(): Promise<void> {
    await this.client.start();
  }

  async stop(): Promise<void> {
    await this.client.disconnect();
  }

  onDown(handler: (reason: string) => void): void {
    this.downHandler = handler;
  }
}
