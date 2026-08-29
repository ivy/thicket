import { cronMatches, parseCron } from "./cron.js";
import type { Logger } from "./logger.js";
import type { Routine, RoutineStore } from "./store/routines.js";

/** Consecutive failing runs before a routine is disabled and reported. */
export const ROUTINE_FAILURE_LIMIT = 5;

/**
 * Retries a one-shot gets after a failed run before it is given up on and
 * reported. One: "check on this tomorrow" deserves a second try, not a
 * week of them.
 */
export const ONE_SHOT_RETRY_LIMIT = 1;

/** How a fired routine turn ended, as the runner needs to know it. */
export interface RoutineTurnResult {
  /** A2A terminal state name, e.g. "completed", "failed", "canceled". */
  state: string;
  error?: string;
}

export interface RoutineRunnerOptions {
  store: RoutineStore;
  /**
   * Drives one turn for the routine and resolves with its terminal state.
   * A cron routine runs in its own session, keyed by its id, so
   * consecutive runs share memory — how "what did I already report?"
   * works. A one-shot runs in its origin thread's session, which is what
   * makes "check if XYZ finished" mean the XYZ that thread was about.
   */
  runTurn: (routine: Routine, prompt: string) => Promise<RoutineTurnResult>;
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

/**
 * A one-shot's framing: the same "nobody is listening to the reply" rule,
 * plus where the answer belongs — the thread that asked.
 */
export function oneShotPrompt(
  routine: { name: string; prompt: string; origin: { channel: string; threadTs: string } | null },
  firedAt: Date,
): string {
  const where =
    routine.origin === null
      ? "the conversation where this was asked"
      : `channel ${routine.origin.channel}, thread ${routine.origin.threadTs}`;
  return (
    `[Scheduled reminder "${routine.name}" fired at ${firedAt.toISOString()}. ` +
    `This turn was started by a schedule, not by a person: your reply text goes ` +
    `nowhere. You were asked, earlier in this same conversation, to come back ` +
    `now and do the following; report the result there with post_message ` +
    `(${where}) — that thread is waiting to hear from you, so say something ` +
    `even if the answer is "nothing changed".]\n\n` +
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

function oneShotFailurePrompt(routine: Routine, lastError: string | undefined): string {
  const where =
    routine.origin === null
      ? "the conversation where it was asked"
      : `channel ${routine.origin.channel}, thread ${routine.origin.threadTs}`;
  return (
    `[Scheduled reminder "${routine.name}" (${routine.id}) could not be carried ` +
    `out: its run failed, and so did the retry. Last error: ${lastError ?? "unknown"}. ` +
    `It will not be tried again. Tell the person who asked, once, with ` +
    `post_message in ${where}: what you were meant to do, that it did not ` +
    `happen, and the error — so they can ask again or look into it.]`
  );
}

/**
 * Fires routines on their schedule. Cron rows get one evaluation per
 * minute against the local wall clock; minutes that pass while the
 * process is down or asleep are skipped, not replayed — "every morning"
 * must not fire three times at noon after a sleep. One-shots are the
 * opposite: due is `now >= at` and not yet fired, so a fire time slept
 * through fires on waking, once — late beats never for "check on this".
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
      if (routine.kind === "at") {
        if (routine.firedMs !== null || routine.atMs === null || routine.atMs > now.getTime()) {
          continue;
        }
        await this.runOneShot(routine, now);
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

  private async attempt(routine: Routine, prompt: string): Promise<RoutineTurnResult> {
    try {
      return await this.runTurn(routine, prompt);
    } catch (err) {
      return { state: "failed", error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async run(routine: Routine, firedAt: Date): Promise<void> {
    this.inFlight.add(routine.id);
    this.logger.info("routine fired", { id: routine.id, name: routine.name });
    try {
      const result = await this.attempt(routine, routinePrompt(routine, firedAt));
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
          await this.runTurn(routine, disablementPrompt(routine, result.error));
        } catch (err) {
          this.logger.warn("disablement report failed", { id: routine.id, err: String(err) });
        }
      }
    } finally {
      this.inFlight.delete(routine.id);
    }
  }

  /**
   * A one-shot fires once. A failed run is retried on the next pass, at
   * most ONE_SHOT_RETRY_LIMIT times; after that it is spent and the
   * origin thread hears why — a silent no-show is the worst outcome for
   * "check on this tomorrow".
   */
  private async runOneShot(routine: Routine, firedAt: Date): Promise<void> {
    this.inFlight.add(routine.id);
    this.logger.info("one-shot fired", {
      id: routine.id,
      name: routine.name,
      lateMs: Math.max(0, firedAt.getTime() - (routine.atMs ?? firedAt.getTime())),
    });
    try {
      const result = await this.attempt(routine, oneShotPrompt(routine, firedAt));
      const failed = result.state !== "completed" && result.state !== "input-required";
      const failures = this.store.recordRun(routine.id, result.state, failed);
      this.logger.info("one-shot run finished", {
        id: routine.id,
        state: result.state,
        ...(result.error === undefined ? {} : { error: result.error }),
        ...(failed ? { attempt: failures } : {}),
      });
      if (!failed) {
        this.store.markFired(routine.id, firedAt.getTime());
        return;
      }
      if (failures <= ONE_SHOT_RETRY_LIMIT) {
        return; // still due: the next pass retries
      }
      this.store.markFired(routine.id, firedAt.getTime());
      this.logger.warn("one-shot given up after retry", { id: routine.id, failures });
      try {
        await this.runTurn(routine, oneShotFailurePrompt(routine, result.error));
      } catch (err) {
        this.logger.warn("one-shot failure report failed", { id: routine.id, err: String(err) });
      }
    } finally {
      this.inFlight.delete(routine.id);
    }
  }
}
