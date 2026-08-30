import { readFileSync } from "node:fs";

/**
 * Turns caller-leg recordings into fixtures: every identifier that names
 * the real account, number, call, host, or location is replaced with a
 * stable stand-in of the same shape, so the file can be committed and
 * still replayed frame for frame. Several recordings (both legs of one
 * call) merge into one timeline ordered by `ms`; SIDs are numbered in the
 * order the files are given, so the first file's call is always CA…0001.
 *
 * Grown from the M0 spike's redactor; keys are scrubbed as well as
 * values, because the handshake candidates put the host in key position.
 */

const KEEP_EMPTY = /^(Called|Caller|From|To)(City|State|Zip)$/;

export function redactRecordings(contents: string[]): string[] {
  const maps = new Map<string, Map<string, string>>();
  const standIn = (kind: string, key: string, make: (n: number) => string): string => {
    let map = maps.get(kind);
    if (map === undefined) {
      maps.set(kind, (map = new Map()));
    }
    let value = map.get(key);
    if (value === undefined) {
      map.set(key, (value = make(map.size + 1)));
    }
    return value;
  };

  const scrubString = (s: string): string =>
    s
      .replace(/\b(AC|CA|VX|PN|SK|AP)([0-9a-f]{32})\b/g, (_, prefix: string, hex: string) =>
        prefix === "AC" ? "AC" + "0".repeat(32) : standIn(prefix, prefix + hex, (n) => prefix + n.toString(16).padStart(32, "0")),
      )
      .replace(/\+1\d{10}/g, (m) => standIn("number", m, (n) => `+1555010000${n}`))
      .replace(/[a-z0-9-]+\.[a-z0-9-]+\.ts\.net/g, "phone.example.net")
      .replace(/\/relay\/[0-9a-f]{24}/g, "/relay/fixture");

  const scrubValue = (key: string, value: unknown): unknown => {
    if (KEEP_EMPTY.test(key)) {
      return "";
    }
    if (key === "CallToken" || key === "x-amzn-bedrock-agentcore-runtime-custom-twilio-signature" || key === "sec-websocket-key") {
      return "<redacted>";
    }
    if (key === "x-forwarded-for") {
      return "203.0.113.1";
    }
    return value;
  };

  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map(walk);
    }
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, inner]) => [scrubString(key), walk(scrubValue(key, inner))]),
      );
    }
    if (typeof value === "string") {
      return scrubString(value);
    }
    return value;
  };

  const entries: Array<{ ms: number; seq: number; line: string }> = [];
  let seq = 0;
  for (const content of contents) {
    for (const line of content.split("\n")) {
      if (line.trim() === "") {
        continue;
      }
      const entry = walk(JSON.parse(line)) as { ms: number };
      entries.push({ ms: entry.ms, seq: seq++, line: JSON.stringify(entry) });
    }
  }
  entries.sort((a, b) => a.ms - b.ms || a.seq - b.seq);
  return entries.map((entry) => entry.line);
}

export function redactFiles(paths: string[]): string[] {
  return redactRecordings(paths.map((path) => readFileSync(path, "utf8")));
}
