import type { InboundEvent } from "./types.js";

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
    };
  }
  if (type === "message") {
    // A message carrying an upload is subtyped file_share; every other
    // subtype is a bot echo, a join, or an edit.
    if (event.bot_id !== undefined) {
      return undefined;
    }
    if (event.subtype !== undefined && event.subtype !== "file_share") {
      return undefined;
    }
    const channel = String(event.channel ?? "");
    const ts = String(event.ts ?? "");
    const threadTs = String(event.thread_ts ?? ts);
    if (event.channel_type === "im") {
      return { kind: "dm", channel, threadTs, text: String(event.text ?? ""), messageTs: ts };
    }
    if (event.thread_ts !== undefined) {
      return {
        kind: "thread_message",
        channel,
        threadTs,
        text: String(event.text ?? ""),
        messageTs: ts,
      };
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
