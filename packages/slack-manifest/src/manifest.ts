import type { AgentCard } from "@a2a-js/sdk";

// Slack v2 app manifest limits. The API enforces these; violating them
// fails apps.manifest.create at provision time, so the renderer enforces
// them at render time instead.
export const NAME_MAX = 35;
export const DESCRIPTION_MAX = 140;
export const LONG_DESCRIPTION_MIN = 174;
export const AGENT_DESCRIPTION_MAX = 300;
export const SUGGESTED_PROMPTS_MAX = 4;

/**
 * Bot events the bridge (task 009) consumes over Socket Mode. Socket Mode
 * replaces the request URL, so event_subscriptions carries only bot_events.
 */
export const BOT_EVENTS = [
  "assistant_thread_started",
  "assistant_thread_context_changed",
  "message.im",
  "app_mention",
  "agent_session_stopped",
  "agent_session_title_changed",
] as const;

export const BOT_SCOPES = [
  "assistant:write",
  "chat:write",
  "im:history",
  "app_mentions:read",
  "channels:history",
] as const;

export interface SlackSuggestedPrompt {
  title: string;
  message: string;
}

/** The v2 manifest subset thicket emits. */
export interface SlackManifest {
  display_information: {
    name: string;
    description: string;
    long_description: string;
    background_color?: string;
  };
  features: {
    bot_user: {
      display_name: string;
      always_online: boolean;
    };
    agent_view: {
      agent_description: string;
      suggested_prompts: SlackSuggestedPrompt[];
      actions: string[];
    };
  };
  oauth_config: {
    scopes: {
      bot: string[];
    };
  };
  settings: {
    org_deploy_enabled: boolean;
    socket_mode_enabled: boolean;
    token_rotation_enabled: boolean;
    event_subscriptions: {
      bot_events: string[];
    };
  };
}

export interface RenderResult {
  manifest: SlackManifest;
  /** Human-readable conditions the operator must handle by hand. */
  warnings: string[];
}

export interface RenderOptions {
  /** display_information.background_color, e.g. "#2c2d30". */
  backgroundColor?: string;
}

export class ManifestRenderError extends Error {
  constructor(agentName: string, detail: string) {
    super(`manifest for agent ${agentName}: ${detail}`);
    this.name = "ManifestRenderError";
  }
}

/** Truncates on a word boundary so the result is at most max characters. */
export function truncateAtWord(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  const ellipsis = "…";
  const room = max - ellipsis.length;
  const slice = text.slice(0, room + 1);
  const lastSpace = slice.lastIndexOf(" ");
  const base = lastSpace > 0 ? slice.slice(0, lastSpace) : text.slice(0, room);
  return base.trimEnd() + ellipsis;
}

function composeLongDescription(card: AgentCard): string {
  const lines: string[] = [card.description.trim()];
  if (card.skills.length > 0) {
    lines.push("", "Skills:");
    for (const skill of card.skills) {
      lines.push(`• ${skill.name}: ${skill.description}`);
    }
  }
  return lines.join("\n");
}

/**
 * Renders one AgentCard into a Slack v2 app manifest. Pure: no network,
 * no filesystem, no clock — anything the operator must do by hand comes
 * back as a warning, and anything the Slack API would reject throws.
 */
export function toSlackManifest(card: AgentCard, options: RenderOptions = {}): RenderResult {
  const warnings: string[] = [];

  if (card.name.length === 0) {
    throw new ManifestRenderError(card.name, "card name is empty");
  }
  if (card.name.length > NAME_MAX) {
    throw new ManifestRenderError(
      card.name,
      `name is ${card.name.length} characters; Slack caps app names at ${NAME_MAX}`,
    );
  }

  const longDescription = composeLongDescription(card);
  if (longDescription.length < LONG_DESCRIPTION_MIN) {
    throw new ManifestRenderError(
      card.name,
      `long_description is ${longDescription.length} characters; Slack requires at least ` +
        `${LONG_DESCRIPTION_MIN}. Expand the roster description or add skill descriptions.`,
    );
  }

  if (card.iconUrl !== undefined && card.iconUrl !== "") {
    warnings.push(
      `agent ${card.name}: the Slack manifest schema has no icon field; ` +
        `upload the icon by hand in app settings (iconUrl: ${card.iconUrl})`,
    );
  }

  const prompts: SlackSuggestedPrompt[] = [];
  for (const skill of card.skills) {
    for (const example of skill.examples) {
      prompts.push({ title: truncateAtWord(skill.name, 40), message: example });
    }
  }
  if (prompts.length > SUGGESTED_PROMPTS_MAX) {
    warnings.push(
      `agent ${card.name}: ${prompts.length} skill examples exceed Slack's ` +
        `${SUGGESTED_PROMPTS_MAX} suggested prompts; keeping the first ${SUGGESTED_PROMPTS_MAX}`,
    );
    prompts.length = SUGGESTED_PROMPTS_MAX;
  }

  const manifest: SlackManifest = {
    display_information: {
      name: card.name,
      description: truncateAtWord(card.description, DESCRIPTION_MAX),
      long_description: longDescription,
      ...(options.backgroundColor !== undefined
        ? { background_color: options.backgroundColor }
        : {}),
    },
    features: {
      bot_user: {
        display_name: card.name,
        always_online: true,
      },
      // agent_view, never assistant_view: new apps can only use agent_view
      // and migrating off assistant_view is irreversible.
      agent_view: {
        agent_description: truncateAtWord(card.description, AGENT_DESCRIPTION_MAX),
        suggested_prompts: prompts,
        actions: card.skills.map((skill) => skill.name),
      },
    },
    oauth_config: {
      scopes: {
        bot: [...BOT_SCOPES],
      },
    },
    settings: {
      org_deploy_enabled: false,
      socket_mode_enabled: true,
      token_rotation_enabled: false,
      event_subscriptions: {
        bot_events: [...BOT_EVENTS],
      },
    },
  };

  return { manifest, warnings };
}
