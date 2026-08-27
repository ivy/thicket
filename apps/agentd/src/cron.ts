/**
 * A five-field cron matcher — minute, hour, day-of-month, month,
 * day-of-week — supporting `*`, numbers, ranges, lists, and steps,
 * evaluated in the host's local time zone. Deliberately no dependency:
 * routines need exactly this much cron and nothing more.
 *
 * Standard cron quirk kept: when both day-of-month and day-of-week are
 * restricted, a date matching either fires.
 */

export interface CronSpec {
  minute: Set<number>;
  hour: Set<number>;
  dayOfMonth: Set<number>;
  month: Set<number>;
  dayOfWeek: Set<number>;
  /** Whether the dom/dow fields were written as `*`. */
  anyDayOfMonth: boolean;
  anyDayOfWeek: boolean;
}

const BOUNDS: [number, number][] = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day of month
  [1, 12], // month
  [0, 7], // day of week; 0 and 7 are both Sunday
];

function parseField(field: string, min: number, max: number): Set<number> | undefined {
  const values = new Set<number>();
  for (const part of field.split(",")) {
    const [rangeRaw, stepRaw, ...junk] = part.split("/");
    if (rangeRaw === undefined || rangeRaw === "" || junk.length > 0) {
      return undefined;
    }
    const step = stepRaw === undefined ? 1 : Number(stepRaw);
    if (!Number.isInteger(step) || step < 1) {
      return undefined;
    }
    let lo: number;
    let hi: number;
    if (rangeRaw === "*") {
      lo = min;
      hi = max;
    } else if (/^\d+$/.test(rangeRaw)) {
      lo = Number(rangeRaw);
      hi = stepRaw === undefined ? lo : max;
    } else {
      const m = /^(\d+)-(\d+)$/.exec(rangeRaw);
      if (m === null) {
        return undefined;
      }
      lo = Number(m[1]);
      hi = Number(m[2]);
    }
    if (lo < min || hi > max || lo > hi) {
      return undefined;
    }
    for (let v = lo; v <= hi; v += step) {
      values.add(v);
    }
  }
  return values;
}

/** Parses a cron expression; undefined means it is not valid cron. */
export function parseCron(expression: string): CronSpec | undefined {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    return undefined;
  }
  const sets: Set<number>[] = [];
  for (let i = 0; i < 5; i += 1) {
    const bounds = BOUNDS[i]!;
    const parsed = parseField(fields[i]!, bounds[0], bounds[1]);
    if (parsed === undefined) {
      return undefined;
    }
    sets.push(parsed);
  }
  const dayOfWeek = sets[4]!;
  if (dayOfWeek.has(7)) {
    dayOfWeek.add(0); // 7 is Sunday too
  }
  return {
    minute: sets[0]!,
    hour: sets[1]!,
    dayOfMonth: sets[2]!,
    month: sets[3]!,
    dayOfWeek,
    anyDayOfMonth: fields[2] === "*",
    anyDayOfWeek: fields[4] === "*",
  };
}

/** Whether the spec fires in the local-time minute containing `date`. */
export function cronMatches(spec: CronSpec, date: Date): boolean {
  if (!spec.minute.has(date.getMinutes()) || !spec.hour.has(date.getHours())) {
    return false;
  }
  if (!spec.month.has(date.getMonth() + 1)) {
    return false;
  }
  const domMatch = spec.dayOfMonth.has(date.getDate());
  const dowMatch = spec.dayOfWeek.has(date.getDay());
  if (spec.anyDayOfMonth && spec.anyDayOfWeek) {
    return true;
  }
  if (spec.anyDayOfMonth) {
    return dowMatch;
  }
  if (spec.anyDayOfWeek) {
    return domMatch;
  }
  return domMatch || dowMatch;
}
