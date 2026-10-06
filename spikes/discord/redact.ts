// Turns the spike's recordings into fixtures fit for a public repository.
//
// Snowflakes are mapped to stable stand-ins so a thread id still equals its
// starter message id and the same user is the same user across lines; names,
// avatars, interaction tokens, signed CDN parameters and filenames are
// replaced; the bot's own edit storm and the guild dump are dropped. What
// survives is the shape of every frame the bridge will have to translate.
//
//   mise exec -- bun spikes/discord/redact.ts ~/thicket-test/spike-discord/recordings tests/fixtures/discord

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const [, , from, to] = process.argv;
if (!from || !to) throw new Error("usage: redact.ts <recordings dir> <fixtures dir>");
mkdirSync(to, { recursive: true });

const ids = new Map<string, string>();
let next = 1000;
function snowflake(id: string): string {
  // Already a stand-in: the structural pass and the whole-line pass must
  // agree, or a thread stops matching its starter message.
  if (id.startsWith("9999999999")) return id;
  let out = ids.get(id);
  if (out === undefined) {
    out = `${next++}`.padStart(18, "9");
    ids.set(id, out);
  }
  return out;
}

const DROP_DISPATCH = new Set(["GUILD_CREATE", "MESSAGE_UPDATE", "GUILD_MEMBER_UPDATE", "THREAD_MEMBER_UPDATE"]);
const ID_KEYS = /^(id|channel_id|guild_id|message_id|application_id|author_id|owner_id|webhook_id|parent_id|last_message_id|thread|attachment_id|response_message_id|role_id)$/;

function scrub(value: unknown, key = ""): unknown {
  if (Array.isArray(value)) {
    if (key === "roles" || key === "_trace" || key === "entitlements" || key === "entitlement_sku_ids") return [];
    return value.map((v) => scrub(v, key === "values" || key === "mentions" ? key : ""));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === "token") {
        out[k] = "<interaction-token>";
      } else if (k === "username" || k === "global_name" || k === "nick" || k === "display_name") {
        out[k] = v === null ? null : k === "username" && typeof v === "string" && v.startsWith("thicket") ? "thicket-dev" : "operator";
      } else if (k === "avatar" || k === "banner" || k === "avatar_decoration_data" || k === "collectibles" || k === "placeholder") {
        // Placeholders are blurred previews of the operator's own media.
        out[k] = null;
      } else if (k === "discriminator") {
        out[k] = "0000";
      } else if (k === "name" && typeof v === "string" && /^[^\s/]+\.[a-z0-9]{1,5}$/i.test(v)) {
        out[k] = `file${v.slice(v.lastIndexOf("."))}`;
      } else if (k === "name" && typeof v === "string" && /^(spike thread|spike-thread)$/.test(v)) {
        out[k] = v;
      } else if (k === "filename" && typeof v === "string") {
        out[k] = `file${v.slice(v.lastIndexOf("."))}`;
      } else if ((k === "url" || k === "proxy_url") && typeof v === "string" && v.includes("discordapp")) {
        out[k] = scrubUrl(v);
      } else if (k === "resolved" && v !== null && typeof v === "object") {
        out[k] = scrubResolved(v as Record<string, Record<string, unknown>>);
      } else if (k === "email" || k === "mfa_enabled" || k === "verified" || k === "permissions" || k === "joined_at") {
        continue;
      } else {
        out[k] = scrub(v, k);
      }
    }
    return out;
  }
  if (typeof value === "string") {
    if (ID_KEYS.test(key) && /^\d{17,20}$/.test(value)) return snowflake(value);
    if (key === "values" && /^\d{17,20}$/.test(value)) return snowflake(value);
    if (key === "mentions") return value;
    // ids inside content: <@123>
    return value.replace(/<@!?(\d{17,20})>/g, (_, id: string) => `<@${snowflake(id)}>`);
  }
  return value;
}

function scrubResolved(resolved: Record<string, Record<string, unknown>>): unknown {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [kind, map] of Object.entries(resolved)) {
    out[kind] = {};
    for (const [id, obj] of Object.entries(map)) out[kind][snowflake(id)] = scrub(obj) as Record<string, unknown>;
  }
  return out;
}

function scrubUrl(url: string): string {
  const u = new URL(url);
  u.pathname = u.pathname
    .replace(/\/\d{17,20}/g, (m) => `/${snowflake(m.slice(1))}`)
    .replace(/\/[^/]+(\.[a-z0-9]+)$/i, "/file$1");
  for (const p of ["ex", "is", "hm"]) if (u.searchParams.has(p)) u.searchParams.set(p, `<${p}>`);
  return u.toString();
}

for (const file of readdirSync(from).filter((f) => f.endsWith(".jsonl"))) {
  const lines = readFileSync(join(from, file), "utf8").split("\n").filter(Boolean);
  const kept: string[] = [];
  let typingSeen = 0;
  for (const line of lines) {
    const entry = JSON.parse(line) as Record<string, unknown>;
    if (entry.kind === "dispatch" && DROP_DISPATCH.has(entry.t as string)) continue;
    if (entry.kind === "dispatch" && entry.t === "TYPING_START" && typingSeen++ > 0) continue;
    // The spike stamps its own timestamp as `t` and a dispatch's type lands in
    // the same key, so only the timestamp form goes.
    if (typeof entry.t === "string" && /^\d{4}-\d{2}-\d{2}T/.test(entry.t)) delete entry.t;
    // Snowflakes also sit in REST paths and in keys the structural pass does
    // not know, so every id-shaped run in the line is mapped the same way.
    kept.push(
      JSON.stringify(scrub(entry))
        // Interaction tokens also travel in REST paths, as the segment after
        // the interaction or application id; a decoded one names a real id.
        .replace(/\/(interactions|webhooks)\/(\d{17,20})\/[A-Za-z0-9_-]{20,}/g, "/$1/$2/<interaction-token>")
        .replace(/\d{17,20}/g, (id) => snowflake(id)),
    );
  }
  writeFileSync(join(to, basename(file)), kept.join("\n") + "\n");
  console.log(`${file}: ${lines.length} → ${kept.length}`);
}
