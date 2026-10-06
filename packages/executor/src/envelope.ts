import type { Message } from "@a2a-js/sdk";

/**
 * The envelope: what every human surface knows about a message beyond its
 * words, in one shape. Where it is, who wrote it, who it names, and what it
 * points at — a reply, a forwarded message, a link, an attachment that
 * belongs to one of those. Bridges write it; the executor reads it, and
 * the preamble it renders is the same prose whichever surface spoke.
 *
 * Ids only, never secrets: a bridge that must keep something out of the
 * prompt (the phone keeps its call identifiers) does not put it here.
 */
export const META_ENVELOPE = "thicket.envelope";

export type Surface = "slack" | "discord";

export interface Place {
  /** The surface's own name for a channel kind: "channel", "DM", "thread", "forum post". */
  kind: string;
  channel: string;
  /** The conversation within the channel, when the surface has one. */
  thread?: string;
  /** The message this envelope wraps. */
  message?: string;
  /** A human-readable name for the place, when the surface gave one for free. */
  name?: string;
}

export type ParticipantKind = "operator" | "person" | "agent" | "role";

export interface Participant {
  id: string;
  name?: string;
  kind: ParticipantKind;
  /** This agent itself. */
  self?: boolean;
}

export interface ReferencedAttachment {
  name: string;
  mediaType: string;
  size: number;
  /** Where the bytes are, when the agent may fetch them. */
  url?: string;
}

/** Something the message points at beyond its own text. */
export type Reference =
  | {
      kind: "reply";
      message: string;
      author?: Participant;
      /** The replied-to text, when the surface delivered it. */
      text?: string;
      attachments?: ReferencedAttachment[];
    }
  | {
      kind: "forward";
      author?: Participant;
      text: string;
      /** Where it was forwarded from, when known. */
      from?: { channel?: string; message?: string };
      attachments?: ReferencedAttachment[];
    }
  | { kind: "link"; url: string; title?: string };

export interface Envelope {
  surface: Surface;
  place: Place;
  author?: Participant;
  mentions?: Participant[];
  references?: Reference[];
}

/** The message's envelope, if a bridge wrote one. */
export function envelopeOf(message: Message): Envelope | undefined {
  const raw = message.metadata?.[META_ENVELOPE];
  if (typeof raw !== "object" || raw === null) {
    return undefined;
  }
  const candidate = raw as Partial<Envelope>;
  if ((candidate.surface !== "slack" && candidate.surface !== "discord") || typeof candidate.place?.channel !== "string") {
    return undefined;
  }
  return candidate as Envelope;
}

const SURFACE_NAME: Record<Surface, string> = { slack: "Slack", discord: "Discord" };

function who(p: Participant | undefined): string {
  if (p === undefined) {
    return "someone";
  }
  const label = p.self ? "you" : (p.name ?? p.id);
  const kind = p.self ? "" : p.kind === "agent" ? " (an agent)" : p.kind === "role" ? " (a role)" : "";
  return p.name !== undefined && !p.self ? `${label}${kind} <${p.id}>` : `${label}${kind}`;
}

function quote(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= 300 ? `"${flat}"` : `"${flat.slice(0, 299)}…"`;
}

function attachmentsLine(refs: ReferencedAttachment[] | undefined): string {
  if (refs === undefined || refs.length === 0) {
    return "";
  }
  return ` It carried ${refs.map((a) => `${a.name} (${a.mediaType}, ${a.size} bytes${a.url === undefined ? "" : `, at ${a.url}`})`).join(", ")}.`;
}

/**
 * The lines that tell the agent where it is and what the message points
 * at, rendered from the envelope so every surface reads alike. The reply
 * reaches the place by itself; the ids are for the thicket tools that must
 * name one. A message with no envelope — local Claude Code over MCP, a
 * schedule — gets nothing, as before.
 */
export function envelopePreamble(message: Message): string {
  const env = envelopeOf(message);
  if (env === undefined) {
    return "";
  }
  const lines: string[] = [];
  const where = `${SURFACE_NAME[env.surface]} ${env.place.kind} ${env.place.channel}` +
    (env.place.thread !== undefined && env.place.thread !== env.place.channel ? `, thread ${env.place.thread}` : "") +
    (env.place.name !== undefined ? ` (${env.place.name})` : "");
  lines.push(
    `You are in ${where}. Your reply reaches it on its own — no tool sends it. The ids ` +
      `are for the thicket tools that must name a place: uploading a file here, or reaching ` +
      `a conversation you are not answering in.`,
  );
  if (env.author !== undefined) {
    lines.push(`The message is from ${who(env.author)}${env.author.kind === "operator" ? ", your operator" : ""}.`);
  }
  const others = (env.mentions ?? []).filter((m) => !m.self);
  if (others.length > 0) {
    lines.push(`It mentions ${others.map(who).join(", ")}.`);
  }
  for (const ref of env.references ?? []) {
    switch (ref.kind) {
      case "reply":
        lines.push(
          `It replies to ${who(ref.author)}${ref.text === undefined ? "" : `, who said ${quote(ref.text)}`}.` +
            attachmentsLine(ref.attachments),
        );
        break;
      case "forward":
        lines.push(`It forwards a message from ${who(ref.author)}: ${quote(ref.text)}.` + attachmentsLine(ref.attachments));
        break;
      case "link":
        lines.push(`It links to ${ref.url}${ref.title === undefined ? "" : ` (${ref.title})`}.`);
        break;
    }
  }
  return lines.join("\n") + "\n\n";
}

/** Links in a message's text, in order, without duplicates. */
export function linksIn(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(/https?:\/\/[^\s<>()|]+/g)) {
    const url = match[0].replace(/[.,;:!?]+$/, "");
    if (!found.includes(url)) {
      found.push(url);
    }
  }
  return found;
}
