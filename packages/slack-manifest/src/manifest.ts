import type { AgentCard } from "@a2a-js/sdk";

// Slack v2 app manifest limits. The API enforces these; violating them
// fails apps.manifest.create at provision time, so the renderer enforces
// them at render time instead.
export const NAME_MAX = 35;
// Slack documents 140 for display_information.description, but the live
// validator rejects 140 ("desc_too_long") and accepts 120 (observed
// 2026-08 against apps.manifest.validate). 120 is the enforced cap here.
export const DESCRIPTION_MAX = 120;
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
  // Redeeming url_private_download on a user's upload; the bridge is the
  // only holder of the token that can.
  "files:read",
  // Agent toolbelt: react, hand back a file, read what was already said,
  // and resolve who and what a message refers to.
  "reactions:write",
  "files:write",
  "groups:history",
  "mpim:history",
  "channels:read",
  "groups:read",
  "users:read",
  "canvases:read",
  // Public-channel search on the bot token. Slack rejects plain
  // `search:read` as a bot scope (observed: illegal_bot_scopes) — that one
  // is user-token only, and a user token is a materially wider credential.
  "search:read.public",
] as const;

/**
 * Scopes for the live-test harness, which must act as a *human* to be
 * useful: the bridge drops bot_id messages precisely so agents cannot
 * answer themselves, so nothing with a bot token can trigger a turn.
 *
 * Installing an app that requests these mints a token acting as the
 * installing operator, everywhere they can reach. Opt-in only, and never
 * for an agent whose blast radius matters.
 */
export const TEST_HARNESS_USER_SCOPES = [
  "chat:write",
  "files:write",
  "channels:history",
  "groups:history",
  "im:history",
  "mpim:history",
  "channels:read",
  "im:read",
  "reactions:read",
  // Resolving an agent's bot user, so the harness can open its DM rather
  // than carrying a hardcoded channel id.
  "users:read",
] as const;

export interface SlackSuggestedPrompt {
  title: string;
  message: string;
}

/**
 * agent_view actions are objects, not bare names — the live validator
 * requires name and description (observed: "must provide an object",
 * then "missing required field: description").
 */
export interface SlackAgentAction {
  name: string;
  description: string;
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
    app_home: {
      messages_tab_enabled: boolean;
      messages_tab_read_only_enabled: boolean;
    };
    bot_user: {
      display_name: string;
      always_online: boolean;
    };
    agent_view: {
      agent_description: string;
      suggested_prompts: SlackSuggestedPrompt[];
      actions: SlackAgentAction[];
    };
  };
  oauth_config: {
    scopes: {
      bot: string[];
      /** Present only when a test-harness user token is wanted. */
      user?: string[];
    };
  };
  settings: {
    org_deploy_enabled: boolean;
    socket_mode_enabled: boolean;
    token_rotation_enabled: boolean;
    event_subscriptions: {
      bot_events: string[];
    };
    /** Block Kit interactions arrive over Socket Mode; no request URL. */
    interactivity: {
      is_enabled: boolean;
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
  /**
   * Request user scopes so an installed app also yields a token that acts
   * as the operator. Only the live-test harness wants this.
   */
  testHarness?: boolean;
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
      // Without an enabled Messages tab, Slack shows "Sending messages to
      // this app has been turned off" and DMs are impossible (observed
      // live) — the whole agent surface hangs off the DM.
      app_home: {
        messages_tab_enabled: true,
        messages_tab_read_only_enabled: false,
      },
      bot_user: {
        display_name: card.name,
        always_online: true,
      },
      // agent_view, never assistant_view: new apps can only use agent_view
      // and migrating off assistant_view is irreversible.
      agent_view: {
        agent_description: truncateAtWord(card.description, AGENT_DESCRIPTION_MAX),
        suggested_prompts: prompts,
        actions: card.skills.map((skill) => ({
          name: skill.name,
          description: skill.description,
        })),
      },
    },
    oauth_config: {
      scopes: {
        bot: [...BOT_SCOPES],
        ...(options.testHarness === true ? { user: [...TEST_HARNESS_USER_SCOPES] } : {}),
      },
    },
    settings: {
      org_deploy_enabled: false,
      socket_mode_enabled: true,
      token_rotation_enabled: false,
      event_subscriptions: {
        bot_events: [...BOT_EVENTS],
      },
      interactivity: { is_enabled: true },
    },
  };

  if (options.testHarness === true) {
    warnings.push(
      `${card.name}: manifest requests user scopes for the live-test harness — ` +
        `installing it mints a token that acts as you, wherever you can reach. ` +
        `Remove the flag and reinstall to revoke.`,
    );
  }

  return { manifest, warnings };
}
