import { createHash } from "node:crypto";

/**
 * Namespace for thicket session IDs (RFC 4122 v5). Fixed forever: changing
 * it would orphan every existing Claude Code session transcript.
 */
export const THICKET_NAMESPACE = "5e0be2bc-7a4f-4a4a-9b25-9c1b2f6f8f31";

/** RFC 4122 version-5 (SHA-1, name-based) UUID. */
export function uuidv5(name: string, namespace: string = THICKET_NAMESPACE): string {
  const ns = Buffer.from(namespace.replaceAll("-", ""), "hex");
  if (ns.length !== 16) {
    throw new Error(`namespace must be a UUID, got ${namespace}`);
  }
  const hash = createHash("sha1").update(ns).update(name, "utf8").digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Session identity is derived, not stored: the same Slack thread always
 * maps to the same UUID, which serves as both the Agent SDK sessionId and
 * the A2A contextId.
 */
export function deriveSessionId(channelId: string, threadTs: string): string {
  return uuidv5(`${channelId}:${threadTs}`);
}
