import type {
  CommandEvent,
  ComponentEvent,
  DiscordAttachment,
  InboundEvent,
  MessageEvent,
  ModalEvent,
} from "./types.js";

/** Interaction types. https://docs.discord.com/developers/interactions/receiving-and-responding */
const INTERACTION = {
  APPLICATION_COMMAND: 2,
  MESSAGE_COMPONENT: 3,
  MODAL_SUBMIT: 5,
} as const;

/** The modal wrapper every form component arrives inside. */
const LABEL = 18;

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** The name a user object offers: a server nickname, the global name, or the username. */
function displayName(user: Record<string, unknown> | undefined, member?: Record<string, unknown>): string | undefined {
  return str(member?.nick) ?? str(user?.global_name) ?? str(user?.username);
}

export function parseAttachments(value: unknown): DiscordAttachment[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const files: DiscordAttachment[] = [];
  for (const raw of value) {
    if (typeof raw !== "object" || raw === null) {
      continue;
    }
    const file = raw as Record<string, unknown>;
    const id = str(file.id);
    const url = str(file.url);
    if (id === undefined || url === undefined) {
      continue;
    }
    files.push({
      id,
      name: str(file.filename) ?? id,
      contentType: str(file.content_type) ?? "application/octet-stream",
      size: typeof file.size === "number" ? file.size : 0,
      url,
    });
  }
  return files;
}

/**
 * A `MESSAGE_CREATE` dispatch, reduced to what the turn table reads. Who
 * wrote it, whether through an app, who it mentions, what it carries. A
 * message with no author is nothing the engine can place and is dropped
 * here; everything else is the engine's decision, because that decision
 * needs the operator list and the engine's own identity.
 */
export function translateMessage(d: Record<string, unknown>): MessageEvent | undefined {
  const author = d.author as Record<string, unknown> | undefined;
  const authorId = str(author?.id);
  const channel = str(d.channel_id);
  const messageId = str(d.id);
  if (authorId === undefined || channel === undefined || messageId === undefined) {
    return undefined;
  }
  const mentioned = Array.isArray(d.mentions) ? (d.mentions as Record<string, unknown>[]) : [];
  const mentions = mentioned.map((m) => str(m.id)).filter((id): id is string => id !== undefined);
  const botMentions = mentioned
    .filter((m) => m.bot === true)
    .map((m) => str(m.id))
    .filter((id): id is string => id !== undefined);
  const mentionNames: Record<string, string> = {};
  for (const m of mentioned) {
    const id = str(m.id);
    const name = displayName(m, m.member as Record<string, unknown> | undefined);
    if (id !== undefined && name !== undefined) {
      mentionNames[id] = name;
    }
  }
  // A message_reference is a reply only when its type says so (0, the
  // default); type 1 is a forward, whose content arrives as snapshots.
  const reference = d.message_reference as Record<string, unknown> | undefined;
  const replyTo = reference?.type === undefined || reference.type === 0 ? str(reference?.message_id) : undefined;
  const referenced = d.referenced_message as Record<string, unknown> | null | undefined;
  const refAuthor = referenced?.author as Record<string, unknown> | undefined;
  const refAuthorId = str(refAuthor?.id);
  const refAuthorName = displayName(refAuthor);
  const reply =
    typeof referenced === "object" && referenced !== null
      ? {
          ...(refAuthorId === undefined
            ? {}
            : {
                author: {
                  id: refAuthorId,
                  ...(refAuthorName === undefined ? {} : { name: refAuthorName }),
                  isApp: refAuthor?.bot === true || str(referenced.webhook_id) !== undefined,
                },
              }),
          ...(str(referenced.content) === undefined ? {} : { text: str(referenced.content)! }),
          files: parseAttachments(referenced.attachments),
        }
      : undefined;
  const forwards = (Array.isArray(d.message_snapshots) ? (d.message_snapshots as Record<string, unknown>[]) : [])
    .map((snapshot) => snapshot.message as Record<string, unknown> | undefined)
    .filter((m): m is Record<string, unknown> => m !== undefined)
    .map((m) => ({ text: typeof m.content === "string" ? m.content : "", files: parseAttachments(m.attachments) }));
  const authorName = displayName(author, d.member as Record<string, unknown> | undefined);
  return {
    kind: "message",
    channel,
    ...(str(d.guild_id) === undefined ? {} : { guild: str(d.guild_id)! }),
    messageId,
    text: typeof d.content === "string" ? d.content : "",
    authorId,
    ...(authorName === undefined ? {} : { authorName }),
    authorIsApp: author?.bot === true || str(d.webhook_id) !== undefined,
    mentions,
    botMentions,
    mentionNames,
    files: parseAttachments(d.attachments),
    type: typeof d.type === "number" ? d.type : -1,
    ...(replyTo === undefined ? {} : { replyTo }),
    ...(reply === undefined ? {} : { reply }),
    forwards,
  };
}

/**
 * An `INTERACTION_CREATE` dispatch: a command, a tap, or a submitted form.
 * The token is what answers it and lives fifteen minutes; it travels with
 * the event and never into a log.
 */
export function translateInteraction(d: Record<string, unknown>): InboundEvent | undefined {
  const interactionId = str(d.id);
  const token = str(d.token);
  const channel = str(d.channel_id);
  const member = d.member as Record<string, unknown> | undefined;
  const userId = str((member?.user as Record<string, unknown> | undefined)?.id) ?? str((d.user as Record<string, unknown> | undefined)?.id);
  const data = (d.data ?? {}) as Record<string, unknown>;
  if (interactionId === undefined || token === undefined || channel === undefined || userId === undefined) {
    return undefined;
  }
  const message = d.message as Record<string, unknown> | undefined;
  switch (d.type) {
    case INTERACTION.APPLICATION_COMMAND: {
      const name = str(data.name);
      if (name === undefined) {
        return undefined;
      }
      const options: Record<string, string> = {};
      if (Array.isArray(data.options)) {
        for (const raw of data.options) {
          const option = raw as Record<string, unknown>;
          const key = str(option.name);
          if (key !== undefined && option.value !== undefined) {
            options[key] = String(option.value);
          }
        }
      }
      const event: CommandEvent = {
        kind: "command",
        interactionId,
        token,
        channel,
        ...(str(d.guild_id) === undefined ? {} : { guild: str(d.guild_id)! }),
        userId,
        name,
        options,
      };
      return event;
    }
    case INTERACTION.MESSAGE_COMPONENT: {
      const customId = str(data.custom_id);
      const messageId = str(message?.id);
      if (customId === undefined || messageId === undefined) {
        return undefined;
      }
      const event: ComponentEvent = {
        kind: "component",
        interactionId,
        token,
        channel,
        messageId,
        userId,
        customId,
        componentType: typeof data.component_type === "number" ? data.component_type : -1,
        values: Array.isArray(data.values) ? data.values.map(String) : [],
      };
      return event;
    }
    case INTERACTION.MODAL_SUBMIT: {
      const customId = str(data.custom_id);
      if (customId === undefined) {
        return undefined;
      }
      const resolved = (data.resolved as Record<string, unknown> | undefined)?.attachments;
      const event: ModalEvent = {
        kind: "modal",
        interactionId,
        token,
        channel,
        ...(str(message?.id) === undefined ? {} : { messageId: str(message?.id)! }),
        userId,
        customId,
        fields: modalFields(data.components),
        attachments: parseAttachments(
          typeof resolved === "object" && resolved !== null ? Object.values(resolved) : [],
        ),
      };
      return event;
    }
    default:
      return undefined;
  }
}

/** Every answered component in a submitted form, unwrapped from its Label. */
function modalFields(value: unknown): ModalEvent["fields"] {
  if (!Array.isArray(value)) {
    return [];
  }
  const fields: ModalEvent["fields"] = [];
  const visit = (raw: unknown) => {
    if (typeof raw !== "object" || raw === null) {
      return;
    }
    const component = raw as Record<string, unknown>;
    if (component.type === LABEL) {
      visit(component.component);
      return;
    }
    if (Array.isArray(component.components)) {
      // A legacy action row.
      component.components.forEach(visit);
      return;
    }
    const customId = str(component.custom_id);
    if (customId === undefined || typeof component.type !== "number") {
      return;
    }
    fields.push({
      customId,
      type: component.type,
      ...(typeof component.value === "string" ? { value: component.value } : {}),
      ...(Array.isArray(component.values) ? { values: component.values.map(String) } : {}),
    });
  };
  value.forEach(visit);
  return fields;
}

/** One Gateway dispatch to the engine's event, or nothing. */
export function translateDispatch(type: string, d: unknown): InboundEvent | undefined {
  if (typeof d !== "object" || d === null) {
    return undefined;
  }
  const data = d as Record<string, unknown>;
  if (type === "MESSAGE_CREATE") {
    return translateMessage(data);
  }
  if (type === "INTERACTION_CREATE") {
    return translateInteraction(data);
  }
  return undefined;
}
