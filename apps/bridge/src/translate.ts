import type { InboundEvent, SlackFile } from "./types.js";

/**
 * Slack sends several URL variants per file; url_private_download is the
 * one that returns the bytes rather than a viewer page. Files still being
 * uploaded, or external ones Slack only links to, have no bytes to serve
 * and are skipped rather than half-recorded.
 */
function parseFiles(value: unknown): SlackFile[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const files: SlackFile[] = [];
  for (const raw of value) {
    if (typeof raw !== "object" || raw === null) {
      continue;
    }
    const file = raw as Record<string, unknown>;
    const id = file.id;
    const downloadUrl = file.url_private_download ?? file.url_private;
    if (typeof id !== "string" || typeof downloadUrl !== "string") {
      continue;
    }
    files.push({
      id,
      name: typeof file.name === "string" && file.name !== "" ? file.name : id,
      mimetype:
        typeof file.mimetype === "string" && file.mimetype !== ""
          ? file.mimetype
          : "application/octet-stream",
      size: typeof file.size === "number" ? file.size : 0,
      downloadUrl,
    });
  }
  return files;
}

/**
 * Unwraps a Slack Events API payload (as delivered over Socket Mode) into
 * the bridge's inbound event type. Returns undefined for events the
 * bridge does not act on — bot echoes, edits, unknown types.
 */
export function translateSlackEvent(event: Record<string, unknown>): InboundEvent | undefined {
  const type = event.type;
  if (type === "app_mention") {
    const channel = String(event.channel ?? "");
    const ts = String(event.ts ?? "");
    return {
      kind: "mention",
      channel,
      threadTs: String(event.thread_ts ?? ts),
      text: String(event.text ?? ""),
      messageTs: ts,
      files: parseFiles(event.files),
      authorId: typeof event.user === "string" ? event.user : "",
      viaApp: event.bot_id !== undefined,
    };
  }
  if (type === "message") {
    // A message carrying an upload is subtyped file_share; every other
    // subtype is a bot echo, a join, or an edit.
    if (event.subtype !== undefined && event.subtype !== "file_share") {
      return undefined;
    }
    // A classic bot post has no author at all. A message that *does* have
    // one may still carry bot_id — posting through any app's user token
    // stamps it (observed: a human message via MCP arrived with hearth's
    // own bot_id) — so bot_id alone cannot mean "a bot said this". Who the
    // author is decides that, and only the caller can resolve it.
    if (typeof event.user !== "string" || event.user === "") {
      return undefined;
    }
    const channel = String(event.channel ?? "");
    const ts = String(event.ts ?? "");
    const threadTs = String(event.thread_ts ?? ts);
    const common = {
      channel,
      threadTs,
      text: String(event.text ?? ""),
      messageTs: ts,
      files: parseFiles(event.files),
      authorId: event.user,
      /** Posted through an app, by a human or a bot — which, is unresolved here. */
      viaApp: event.bot_id !== undefined,
    };
    if (event.channel_type === "im") {
      return { kind: "dm", ...common };
    }
    if (event.thread_ts !== undefined) {
      return { kind: "thread_message", ...common };
    }
    return undefined; // top-level channel chatter without a mention
  }
  if (type === "agent_session_stopped") {
    // Field layout per Slack agent events; tolerate both flat and nested.
    const session = (event.session ?? event) as Record<string, unknown>;
    const channel = String(session.channel_id ?? session.channel ?? "");
    const threadTs = String(session.thread_ts ?? "");
    if (channel === "" || threadTs === "") {
      return undefined;
    }
    return { kind: "session_stopped", channel, threadTs };
  }
  return undefined;
}
