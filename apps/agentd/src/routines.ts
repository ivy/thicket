import { cronMatches, parseCron } from "./cron.js";
import type { Logger } from "./logger.js";
import type { Routine, RoutineStore } from "./store/routines.js";

/** Consecutive failing runs before a routine is disabled and reported. */
export const ROUTINE_FAILURE_LIMIT = 5;

/** How a fired routine turn ended, as the runner needs to know it. */
export interface RoutineTurnResult {
  /** A2A terminal state name, e.g. "completed", "failed", "canceled". */
  state: string;
  error?: string;
}

export interface RoutineRunnerOptions {
  store: RoutineStore;
  /**
   * Drives one turn in the routine's own session and resolves with its
   * terminal state. `routineId` keys the session, so consecutive runs of
   * one routine share memory — how "what did I already report?" works.
   */
  runTurn: (routineId: string, prompt: string) => Promise<RoutineTurnResult>;
  logger: Logger;
  now?: () => Date;
}

/** The framing every routine run carries; behaviour, stated at the seam. */
export function routinePrompt(routine: { name: string; prompt: string }, firedAt: Date): string {
  return (
    `[Scheduled routine "${routine.name}" fired at ${firedAt.toISOString()}. ` +
    `You are not talking to anyone: this turn was started by a schedule, and ` +
    `your reply text goes nowhere. Anything worth saying must go through your ` +
    `thicket Slack tools. Silence is the expected outcome most runs — if there ` +
    `is nothing new, post nothing.]\n\n` +
    routine.prompt
  );
}

function disablementPrompt(routine: Routine, lastError: string | undefined): string {
  return (
    `[Routine "${routine.name}" (${routine.id}) has been disabled after ` +
    `${ROUTINE_FAILURE_LIMIT} consecutive failing runs. Last error: ` +
    `${lastError ?? "unknown"}. Tell the operator once, using post_message in ` +
    `the conversation where this routine's output was expected (or the most ` +
    `sensible one you can see). Include the routine id so it can be fixed and ` +
    `re-enabled.]`
  );
}

/**
 * Fires routines on their schedule. One evaluation per routine per
 * minute, matched against the wall clock in local time; minutes that
 * pass while the process is down or asleep are skipped, not replayed —
 * "every morning" must not fire three times at noon after a sleep.
 * Overlap is prevented per routine: a run still in flight when the next
 * match comes up wins, and the match is skipped.
 */
export class RoutineRunner {
  private readonly store: RoutineStore;
  private readonly runTurn: RoutineRunnerOptions["runTurn"];
  private readonly logger: Logger;
  private readonly now: () => Date;
  private readonly firedMinute = new Map<string, number>();
  private readonly inFlight = new Set<string>();
  private timer: NodeJS.Timeout | null = null;

  constructor(options: RoutineRunnerOptions) {
    this.store = options.store;
    this.runTurn = options.runTurn;
    this.logger = options.logger;
    this.now = options.now ?? (() => new Date());
  }

  start(intervalMs = 20_000): void {
    if (this.timer !== null) {
      return;
    }
    this.timer = setInterval(() => {
      void this.tick();
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One scheduler pass; exposed for tests and called on an interval. */
  async tick(): Promise<void> {
    const now = this.now();
    const minute = Math.floor(now.getTime() / 60_000);
    for (const routine of this.store.list()) {
      if (!routine.enabled || this.inFlight.has(routine.id)) {
        continue;
      }
      if (this.firedMinute.get(routine.id) === minute) {
        continue;
      }
      const spec = parseCron(routine.cron);
      if (spec === undefined) {
        // Validated at create/update; reaching this means the store was
        // hand-edited. Say so rather than silently never firing.
        this.logger.warn("routine has unparseable cron; skipping", {
          id: routine.id,
          cron: routine.cron,
        });
        continue;
      }
      if (!cronMatches(spec, now)) {
        continue;
      }
      this.firedMinute.set(routine.id, minute);
      await this.run(routine, now);
    }
  }

  private async run(routine: Routine, firedAt: Date): Promise<void> {
    this.inFlight.add(routine.id);
    this.logger.info("routine fired", { id: routine.id, name: routine.name });
    try {
      let result: RoutineTurnResult;
      try {
        result = await this.runTurn(routine.id, routinePrompt(routine, firedAt));
      } catch (err) {
        result = { state: "failed", error: err instanceof Error ? err.message : String(err) };
      }
      const failed = result.state !== "completed" && result.state !== "input-required";
      const failures = this.store.recordRun(routine.id, result.state, failed);
      this.logger.info("routine run finished", {
        id: routine.id,
        state: result.state,
        ...(result.error === undefined ? {} : { error: result.error }),
        ...(failed ? { consecutiveFailures: failures } : {}),
      });
      if (failed && failures >= ROUTINE_FAILURE_LIMIT) {
        // Fail closed: an autonomous agent looping unattended spends real
        // money, and a routine designed for silence is the worst place
        // for a silent failure. Disable, then say so exactly once —
        // through the agent, which is the only thing here that can post.
        this.store.disable(routine.id);
        this.logger.warn("routine disabled after consecutive failures", {
          id: routine.id,
          failures,
        });
        try {
          await this.runTurn(routine.id, disablementPrompt(routine, result.error));
        } catch (err) {
          this.logger.warn("disablement report failed", { id: routine.id, err: String(err) });
        }
      }
    } finally {
      this.inFlight.delete(routine.id);
    }
  }
}
