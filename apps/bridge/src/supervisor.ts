import type { EngineLogger } from "./engine.js";

/**
 * One Socket Mode connection's lifecycle, abstracted so tests can drive
 * disconnects without a network. Production wraps @slack/socket-mode.
 */
export interface Connection {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Fired when the connection drops for good (built-in retries exhausted). */
  onDown(handler: (reason: string) => void): void;
}

export type ConnectionFactory = (agent: string) => Connection;

export interface SupervisorOptions {
  agents: string[];
  factory: ConnectionFactory;
  logger?: EngineLogger;
  /** Backoff schedule in ms; the last entry repeats. */
  backoffMs?: number[];
}

const DEFAULT_BACKOFF_MS = [1_000, 5_000, 15_000, 60_000];

export interface ConnectionHealth {
  agent: string;
  connected: boolean;
  /** Reconnect attempts since the last successful connect. */
  attempts: number;
}

interface Slot {
  agent: string;
  connection: Connection | null;
  attempts: number;
  timer: NodeJS.Timeout | null;
}

/**
 * Keeps one connection per agent alive. A dropped connection is restarted
 * with backoff in its own slot; other agents' connections are untouched
 * and the process never exits over a reconnect.
 */
export class ConnectionSupervisor {
  private readonly factory: ConnectionFactory;
  private readonly logger: EngineLogger;
  private readonly backoffMs: number[];
  private readonly slots = new Map<string, Slot>();
  private stopped = false;

  constructor(options: SupervisorOptions) {
    this.factory = options.factory;
    this.logger = options.logger ?? { info: () => {}, warn: () => {} };
    this.backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;
    for (const agent of options.agents) {
      this.slots.set(agent, { agent, connection: null, attempts: 0, timer: null });
    }
  }

  async start(): Promise<void> {
    await Promise.all([...this.slots.values()].map((slot) => this.connect(slot)));
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const slot of this.slots.values()) {
      if (slot.timer !== null) {
        clearTimeout(slot.timer);
        slot.timer = null;
      }
      if (slot.connection !== null) {
        await slot.connection.stop();
        slot.connection = null;
      }
    }
  }

  /** Live connection count, for tests and health reporting. */
  get connectedCount(): number {
    let n = 0;
    for (const slot of this.slots.values()) {
      if (slot.connection !== null) {
        n += 1;
      }
    }
    return n;
  }

  /** Per-agent connection state, for the health file doctor reads. */
  health(): ConnectionHealth[] {
    return [...this.slots.values()].map((slot) => ({
      agent: slot.agent,
      connected: slot.connection !== null,
      attempts: slot.attempts,
    }));
  }

  private async connect(slot: Slot): Promise<void> {
    if (this.stopped) {
      return;
    }
    const connection = this.factory(slot.agent);
    connection.onDown((reason) => {
      this.logger.warn("socket mode connection down", { agent: slot.agent, reason });
      slot.connection = null;
      this.scheduleReconnect(slot);
    });
    try {
      await connection.start();
      slot.connection = connection;
      slot.attempts = 0;
      this.logger.info("socket mode connected", { agent: slot.agent });
    } catch (err) {
      this.logger.warn("socket mode connect failed", {
        agent: slot.agent,
        err: String(err),
      });
      this.scheduleReconnect(slot);
    }
  }

  private scheduleReconnect(slot: Slot): void {
    if (this.stopped || slot.timer !== null) {
      return;
    }
    const delay =
      this.backoffMs[Math.min(slot.attempts, this.backoffMs.length - 1)] ??
      DEFAULT_BACKOFF_MS[0]!;
    slot.attempts += 1;
    slot.timer = setTimeout(() => {
      slot.timer = null;
      void this.connect(slot);
    }, delay);
    slot.timer.unref?.();
  }
}
