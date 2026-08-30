// Turns spike recordings into a fixture: every identifier that names the real account,
// number, call, host, or location is replaced with a stable stand-in of the same shape,
// so the file can be committed and still replayed frame for frame. Several recordings
// (the relay leg and the synthetic caller leg of one call) merge into one timeline,
// ordered by `ms`; SIDs are numbered in the order the files are given, so the first
// file's call is always CA…0001.
//
//   mise exec -- bun spikes/conversationrelay/redact.ts <relay.jsonl> [caller.jsonl] > fixture.jsonl

import { readFileSync } from "node:fs";

// One counter per kind of identifier, so the relay leg is CA…0001 and its first
// session VX…0001 regardless of what else the file mentions.
const maps = new Map<string, Map<string, string>>();
function standIn(kind: string, key: string, make: (n: number) => string): string {
  let map = maps.get(kind);
  if (!map) maps.set(kind, (map = new Map()));
  let v = map.get(key);
  if (!v) map.set(key, (v = make(map.size + 1)));
  return v;
}

const KEEP_EMPTY = /^(Called|Caller|From|To)(City|State|Zip)$/;

function scrubValue(key: string, value: unknown): unknown {
  if (KEEP_EMPTY.test(key)) return "";
  if (key === "CallToken" || key === "x-amzn-bedrock-agentcore-runtime-custom-twilio-signature" || key === "sec-websocket-key") return "<redacted>";
  if (key === "x-forwarded-for") return "203.0.113.1";
  return value;
}

function walk(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(walk);
  if (v && typeof v === "object") {
    // Keys are scrubbed too: the caller leg records signature candidates as
    // {url: matched}, which puts the host and secret path in key position.
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [scrubString(k), walk(scrubValue(k, x))]));
  }
  if (typeof v === "string") return scrubString(v);
  return v;
}

function scrubString(s: string): string {
  return s
    .replace(/\b(AC|CA|VX|PN|SK|AP)([0-9a-f]{32})\b/g, (_, p: string, hex: string) =>
      p === "AC" ? "AC" + "0".repeat(32) : standIn(p, p + hex, (n) => p + n.toString(16).padStart(32, "0")),
    )
    .replace(/\+1\d{10}/g, (m) => standIn("number", m, (n) => `+1555010000${n}`))
    .replace(/[a-z0-9-]+\.[a-z0-9-]+\.ts\.net/g, "phone.example.net")
    .replace(/\/relay\/[0-9a-f]{24}/g, "/relay/fixture");
}

const entries: Array<{ ms: number; seq: number; line: string }> = [];
let seq = 0;
for (const path of process.argv.slice(2)) {
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const entry = walk(JSON.parse(line)) as { ms: number };
    entries.push({ ms: entry.ms, seq: seq++, line: JSON.stringify(entry) });
  }
}
entries.sort((a, b) => a.ms - b.ms || a.seq - b.seq);
for (const e of entries) console.log(e.line);
