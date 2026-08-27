import { SocketModeClient } from "@slack/socket-mode";

import type { Connection } from "./supervisor.js";
import { translateSlackEvent } from "./translate.js";
import type { InboundEvent } from "./types.js";

/**
 * Socket Mode connection for one agent app. The @slack/socket-mode client
 * handles ping/pong and transparent reconnects; the supervisor only hears
 * about terminal failures.
 */
export class SlackSocketConnection implements Connection {
  private readonly client: SocketModeClient;
  private downHandler: ((reason: string) => void) | null = null;

  constructor(appToken: string, onEvent: (event: InboundEvent) => void) {
    this.client = new SocketModeClient({ appToken });
    this.client.on("slack_event", (args: { ack?: () => Promise<void>; event?: unknown; body?: unknown }) => {
      void args.ack?.();
      const body = (args.body ?? {}) as { event?: Record<string, unknown> };
      const raw = (args.event ?? body.event) as Record<string, unknown> | undefined;
      if (raw === undefined) {
        return;
      }
      const event = translateSlackEvent(raw);
      if (event !== undefined) {
        onEvent(event);
      }
    });
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
