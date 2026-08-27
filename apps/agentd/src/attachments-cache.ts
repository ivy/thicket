import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

/** How long an attachment stays fetchable without being re-downloaded. */
export const ATTACHMENT_RETENTION_MS = 30 * 24 * 60 * 60_000;

/**
 * Drop attachment directories nobody has touched lately.
 *
 * Discarding is safe because the bridge can always re-serve the file: this
 * is a cache in the XDG sense, not a place where the only copy lives. A
 * context is dropped whole, so a thread's files disappear together rather
 * than leaving a half-populated directory behind.
 *
 * Returns the number of context directories removed.
 */
export async function pruneAttachments(
  dir: string,
  retentionMs: number = ATTACHMENT_RETENTION_MS,
  now: number = Date.now(),
): Promise<number> {
  let contexts: string[];
  try {
    contexts = await readdir(dir);
  } catch {
    return 0; // nothing has been stored yet
  }
  let dropped = 0;
  for (const context of contexts) {
    const path = join(dir, context);
    const info = await stat(path).catch(() => undefined);
    if (info === undefined || !info.isDirectory()) {
      continue;
    }
    if (now - info.mtimeMs < retentionMs) {
      continue;
    }
    await rm(path, { recursive: true, force: true });
    dropped += 1;
  }
  return dropped;
}
