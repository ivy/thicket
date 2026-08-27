import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import type { Message } from "@a2a-js/sdk";

/** Metadata key the bridge stamps with an attachment's byte count. */
export const META_FILE_SIZE = "thicket.fileSize";

/** Default ceiling on a single attachment. Disk sanity, not memory. */
export const DEFAULT_MAX_ATTACHMENT_BYTES = 200 * 1024 * 1024;

/** A file referred to by an inbound message, not yet on this machine. */
export interface AttachmentRef {
  url: string;
  filename: string;
  mediaType: string;
  /** Declared size; 0 when the sender did not say. */
  size: number;
}

export interface StoredAttachment {
  path: string;
  filename: string;
  mediaType: string;
  bytes: number;
}

export class AttachmentTooLarge extends Error {
  constructor(limit: number) {
    super(`attachment exceeds ${limit} bytes`);
    this.name = "AttachmentTooLarge";
  }
}

/** The url parts of an inbound message, in order. */
export function attachmentRefs(message: Message): AttachmentRef[] {
  return message.parts
    .filter((part) => part.content?.$case === "url")
    .map((part) => ({
      url: part.content?.$case === "url" ? part.content.value : "",
      filename: part.filename,
      mediaType: part.mediaType === "" ? "application/octet-stream" : part.mediaType,
      size: Number(part.metadata?.[META_FILE_SIZE] ?? 0),
    }));
}

/**
 * A filename from an upload is written by whoever uploaded it. Reduce it to
 * a single path segment that cannot traverse, hide, or overflow, and never
 * trust it to be non-empty.
 */
export function safeName(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? "";
  const cleaned = base
    // Control characters are exactly what we mean to strip: a filename
    // carrying a NUL or a newline is trying something.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/^\.+/, "")
    .trim();
  if (cleaned === "" || cleaned === "." || cleaned === "..") {
    return "attachment";
  }
  return cleaned.length <= 128 ? cleaned : cleaned.slice(-128);
}

function segment(value: string): string {
  return /^[A-Za-z0-9._-]+$/.test(value) && !value.startsWith(".")
    ? value
    : createHash("sha256").update(value).digest("hex").slice(0, 32);
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

export interface AttachmentStoreOptions {
  /** Base directory; one subdirectory per context. */
  dir: string;
  /** Injected so tests need no network and agentd can route through netd. */
  fetchImpl?: typeof fetch;
  maxBytes?: number;
}

/**
 * Streams referred-to files onto this machine so the model can open them
 * with the same tools it uses for anything else.
 *
 * Nothing is held in memory: a 1 GB upload costs disk and time, not heap.
 * Files land under a directory derived from their URL, so two uploads
 * sharing a name cannot collide and re-delivering one is free.
 */
export class AttachmentStore {
  private readonly dir: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxBytes: number;

  constructor(options: AttachmentStoreOptions) {
    this.dir = options.dir;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES;
  }

  pathFor(contextId: string, ref: AttachmentRef): string {
    return join(this.dir, segment(contextId), digest(ref.url), safeName(ref.filename));
  }

  async store(contextId: string, ref: AttachmentRef): Promise<StoredAttachment> {
    const path = this.pathFor(contextId, ref);
    const describe = (bytes: number): StoredAttachment => ({
      path,
      filename: safeName(ref.filename),
      mediaType: ref.mediaType,
      bytes,
    });

    const existing = await stat(path).catch(() => undefined);
    if (existing !== undefined) {
      return describe(existing.size); // already here: the url names the bytes
    }
    if (ref.size > this.maxBytes) {
      throw new AttachmentTooLarge(this.maxBytes);
    }

    const response = await this.fetchImpl(ref.url);
    if (!response.ok || response.body === null) {
      throw new Error(`fetch failed: ${response.status}`);
    }
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > this.maxBytes) {
      throw new AttachmentTooLarge(this.maxBytes);
    }

    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    // Write beside the target and rename: an interrupted transfer must not
    // leave something that looks like a complete file.
    const partial = `${path}.part`;
    let bytes = 0;
    const limit = this.maxBytes;
    const count = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        // Content-Length is the sender's claim; the stream is the fact.
        callback(bytes > limit ? new AttachmentTooLarge(limit) : null, chunk);
      },
    });
    try {
      await pipeline(
        Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
        count,
        createWriteStream(partial, { mode: 0o600 }),
      );
    } catch (err) {
      await rm(partial, { force: true });
      throw err;
    }
    await rename(partial, path);
    return describe(bytes);
  }
}

/**
 * What the model sees ahead of the user's words: the attachments as
 * context, so the message itself stays the instruction.
 */
export function attachmentPreamble(
  stored: StoredAttachment[],
  failures: { filename: string; reason: string }[],
): string {
  const lines: string[] = [];
  if (stored.length > 0) {
    lines.push(
      stored.length === 1
        ? "The user attached a file, saved on this machine:"
        : `The user attached ${stored.length} files, saved on this machine:`,
    );
    for (const file of stored) {
      lines.push(`  ${file.path} (${file.mediaType}, ${formatBytes(file.bytes)})`);
    }
  }
  for (const failure of failures) {
    lines.push(`The user attached ${failure.filename}, but it could not be retrieved: ${failure.reason}`);
  }
  return lines.length === 0 ? "" : `${lines.join("\n")}\n\n`;
}
