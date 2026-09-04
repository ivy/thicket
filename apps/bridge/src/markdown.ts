/**
 * Splitting long answers into several Slack messages, without breaking the
 * Markdown they are written in.
 *
 * Slack renders each message on its own, so a fenced code block that spans
 * a split loses its fence: the tail of the block arrives as prose. Every
 * piece produced here therefore stands alone — a split inside a fence
 * closes it, and the next piece reopens it with the same marker and info
 * string.
 *
 * Fence syntax follows CommonMark's fenced code blocks
 * (https://spec.commonmark.org/0.31.2/#fenced-code-blocks) as far as the
 * opener/closer rules; nothing here needs the block's contents.
 */

/** An open fence: the run that opened it, and its info string. */
export interface Fence {
  /** The literal run that opened the block, e.g. "```" or "~~~~". */
  readonly marker: string;
  /** The info string on the opening line, e.g. "ts". */
  readonly info: string;
}

/**
 * Where a scan of the text so far has left us. `partial` is the text after
 * the last newline: a line that may yet turn out to be a fence, once the
 * rest of it arrives. Streamed deltas break mid-line, so carrying it is
 * what lets fence tracking survive them.
 */
export interface Cursor {
  readonly fence: Fence | undefined;
  readonly partial: string;
}

/** A cursor over no text at all. */
export const START: Cursor = { fence: undefined, partial: "" };

/** The line that would reopen the cursor's fence in a fresh message. */
export function reopen(cursor: Cursor): string {
  return cursor.fence === undefined ? "" : `${cursor.fence.marker}${cursor.fence.info}\n`;
}

/** The line that closes the cursor's fence, newline included. */
function closer(fence: Fence): string {
  return `\n${fence.marker}`;
}

const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/** The fence a line would open or close, if it is a fence line at all. */
function fenceLine(line: string): Fence | undefined {
  const m = FENCE_LINE.exec(line);
  if (m === null) {
    return undefined;
  }
  return { marker: m[1] ?? "", info: (m[2] ?? "").trim() };
}

/** The fence state after one complete line. */
function step(fence: Fence | undefined, line: string): Fence | undefined {
  const found = fenceLine(line);
  if (found === undefined) {
    return fence;
  }
  if (fence === undefined) {
    // A backtick info string may not itself contain a backtick.
    return found.marker.startsWith("`") && found.info.includes("`") ? undefined : found;
  }
  // Only a bare run of the same character, at least as long, closes it.
  const closes =
    found.marker[0] === fence.marker[0] &&
    found.marker.length >= fence.marker.length &&
    found.info === "";
  return closes ? undefined : fence;
}

/** The cursor after appending `text` to everything scanned so far. */
export function advance(cursor: Cursor, text: string): Cursor {
  const lines = (cursor.partial + text).split("\n");
  const partial = lines.pop() ?? "";
  let fence = cursor.fence;
  for (const line of lines) {
    fence = step(fence, line);
  }
  return { fence, partial };
}

/**
 * Room to reserve for the fence this piece may have to close. The fence
 * open at the cut is not known before the cut is chosen, so the longest
 * marker in play is what gets reserved.
 */
function reserve(text: string, cursor: Cursor): number {
  let longest = cursor.fence?.marker.length ?? 0;
  for (const m of text.matchAll(/^ {0,3}(`{3,}|~{3,})/gm)) {
    longest = Math.max(longest, (m[1] ?? "").length);
  }
  return longest === 0 ? 0 : longest + 1;
}

/**
 * How much of the budget may be given up to reach a better boundary. A
 * paragraph break reads better than a line break, but not at the price of
 * half an empty message — which is what preferring one unconditionally
 * costs when a long code block follows a short paragraph.
 */
const BOUNDARY_SLACK = 0.1;

/** Cut quality, best first. */
const PARAGRAPH = 1;
const LINE = 2;
const IN_FENCE = 3;

interface Candidate {
  /** Offset of the line that starts the remainder. */
  readonly offset: number;
  readonly rank: number;
  readonly fence: Fence | undefined;
}

/** Line boundaries in `text` that leave a piece of at most `limit` characters. */
function candidates(text: string, limit: number, cursor: Cursor): Candidate[] {
  const found: Candidate[] = [];
  let fence = cursor.fence;
  let at = 0;
  while (at <= limit) {
    const nl = text.indexOf("\n", at);
    if (nl < 0 || nl > limit) {
      break;
    }
    // The first line continues whatever the cursor was left holding.
    const line = (at === 0 ? cursor.partial : "") + text.slice(at, nl);
    fence = step(fence, line);
    at = nl + 1;
    if (at > 0) {
      const rank = fence !== undefined ? IN_FENCE : line === "" ? PARAGRAPH : LINE;
      found.push({ offset: at, rank, fence });
    }
  }
  return found;
}

/** The best candidate: highest quality among those that fill the budget. */
function pick(found: Candidate[], budget: number): Candidate | undefined {
  const latest = found.at(-1);
  if (latest === undefined) {
    return undefined;
  }
  const floor = latest.offset - Math.floor(budget * BOUNDARY_SLACK);
  let best = latest;
  for (const c of found) {
    if (c.offset >= floor && c.rank < best.rank) {
      best = c;
    }
  }
  return best;
}

/** One piece of a split, and where the rest of the text picks up. */
export interface Chunk {
  /** Text for the current message, fence closed if the cut is inside one. */
  readonly head: string;
  /** What did not fit; empty when the whole text did. */
  readonly rest: string;
  /** The cursor `rest` starts from — a fresh message, so a fresh line. */
  readonly cursor: Cursor;
}

/**
 * Takes as much of `text` as `budget` characters allow, ending at a
 * boundary a reader can live with and closing any fence the cut falls
 * inside. `budget` is the room left in the current message; the caller
 * prepends `reopen(chunk.cursor)` when it opens the next one.
 */
export function takeChunk(text: string, budget: number, cursor: Cursor = START): Chunk {
  if (text.length <= budget) {
    return { head: text, rest: "", cursor: advance(cursor, text) };
  }
  const limit = Math.max(1, budget - reserve(text, cursor));
  const cut = pick(candidates(text, limit, cursor), budget);
  if (cut !== undefined) {
    // slice() ends on the newline before the remainder's line, so an
    // in-fence close reads as its own line without adding one.
    const raw = text.slice(0, cut.offset);
    const head =
      cut.fence === undefined ? raw.replace(/\n+$/, "") : raw + cut.fence.marker;
    return {
      head,
      rest: text.slice(cut.offset),
      cursor: { fence: cut.fence, partial: "" },
    };
  }
  // No line boundary fits: break the line itself, at a space if there is
  // one, and hard-cut only for an unbroken run longer than the budget.
  const space = text.slice(0, limit + 1).lastIndexOf(" ");
  const at = space > 0 ? space : limit;
  const fence = advance(cursor, text.slice(0, at)).fence;
  return {
    head: text.slice(0, at) + (fence === undefined ? "" : closer(fence)),
    rest: text.slice(at).replace(/^ +/, ""),
    cursor: { fence, partial: "" },
  };
}

/**
 * Splits text into pieces of at most `max` characters, each one valid
 * Markdown on its own.
 */
export function splitMarkdown(text: string, max: number): string[] {
  const pieces: string[] = [];
  let cursor = START;
  let rest = text;
  while (rest !== "") {
    const prefix = reopen(cursor);
    const chunk = takeChunk(rest, Math.max(1, max - prefix.length), cursor);
    if (chunk.head !== "") {
      pieces.push(prefix + chunk.head);
    }
    cursor = chunk.cursor;
    rest = chunk.rest;
  }
  return pieces;
}
