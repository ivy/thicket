/**
 * The streaming editor. The executor emits text deltas far faster than a
 * channel's edit bucket refills, so edits are coalesced: for each card only
 * the latest body is kept, and a channel flushes at most one card per
 * interval, round-robin across its pending cards, so two agents in one
 * thread share the budget rather than exceed it. The interval is seeded
 * from the recording (one a second held with no refusal) and the REST
 * client underneath still obeys the headers.
 */

/**
 * Carries one body to the API. Its errors are its own to handle — the
 * engine's flush abandons the card and buffers the text — and one that
 * escapes is dropped here rather than allowed to wedge the lane.
 */
export type Flush = (channel: string, messageId: string, body: unknown) => Promise<void>;

interface Pending {
  body: unknown;
  /** Resolved once this body, or a later one, has been flushed. */
  waiters: (() => void)[];
}

interface Lane {
  pending: Map<string, Pending>;
  timer: NodeJS.Timeout | null;
  lastFlushAt: number;
  flushing: boolean;
}

export interface EditorOptions {
  flush: Flush;
  intervalMs?: number;
  now?: () => number;
}

export class CardEditor {
  private readonly lanes = new Map<string, Lane>();
  private readonly flush: Flush;
  private readonly intervalMs: number;
  private readonly now: () => number;

  constructor(options: EditorOptions) {
    this.flush = options.flush;
    this.intervalMs = options.intervalMs ?? 1_000;
    this.now = options.now ?? Date.now;
  }

  /** The latest body for a card; an earlier one not yet flushed is replaced. */
  schedule(channel: string, messageId: string, body: unknown): void {
    const lane = this.lane(channel);
    const pending = lane.pending.get(messageId);
    if (pending === undefined) {
      lane.pending.set(messageId, { body, waiters: [] });
    } else {
      pending.body = body;
    }
    this.arm(channel, lane);
  }

  /**
   * Flush a card's latest body as soon as the lane allows, and wait for it.
   * A terminal edit uses this: the answer's final state should not sit in
   * a queue behind a frame nobody will see.
   */
  async settle(channel: string, messageId: string, body?: unknown): Promise<void> {
    const lane = this.lane(channel);
    if (body !== undefined) {
      this.schedule(channel, messageId, body);
    }
    const pending = lane.pending.get(messageId);
    if (pending === undefined) {
      return;
    }
    await new Promise<void>((resolve) => {
      pending.waiters.push(resolve);
      this.arm(channel, lane);
    });
  }

  /** Drop whatever is queued for a card the bridge can no longer edit. */
  forget(channel: string, messageId: string): void {
    const lane = this.lanes.get(channel);
    const pending = lane?.pending.get(messageId);
    if (lane === undefined || pending === undefined) {
      return;
    }
    lane.pending.delete(messageId);
    pending.waiters.forEach((resolve) => resolve());
  }

  /** Pending edits across every channel, for tests and the health file. */
  get pendingCount(): number {
    let n = 0;
    for (const lane of this.lanes.values()) {
      n += lane.pending.size;
    }
    return n;
  }

  private lane(channel: string): Lane {
    let lane = this.lanes.get(channel);
    if (lane === undefined) {
      lane = { pending: new Map(), timer: null, lastFlushAt: 0, flushing: false };
      this.lanes.set(channel, lane);
    }
    return lane;
  }

  private arm(channel: string, lane: Lane): void {
    if (lane.timer !== null || lane.flushing || lane.pending.size === 0) {
      return;
    }
    const due = Math.max(0, lane.lastFlushAt + this.intervalMs - this.now());
    lane.timer = setTimeout(() => {
      lane.timer = null;
      void this.tick(channel, lane);
    }, due);
    lane.timer.unref?.();
  }

  private async tick(channel: string, lane: Lane): Promise<void> {
    // Oldest pending card first: insertion order is arrival order, and a
    // card flushed goes to the back of the line by being re-inserted.
    const next = lane.pending.entries().next();
    if (next.done) {
      return;
    }
    const [messageId, pending] = next.value;
    lane.pending.delete(messageId);
    lane.flushing = true;
    lane.lastFlushAt = this.now();
    try {
      await this.flush(channel, messageId, pending.body);
    } catch {
      // The flush owns its failures; see Flush.
    } finally {
      lane.flushing = false;
      pending.waiters.forEach((resolve) => resolve());
      this.arm(channel, lane);
    }
  }
}
