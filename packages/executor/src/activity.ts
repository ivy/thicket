/**
 * Tool activity: the steps an agent takes inside a turn, rendered for a
 * human watching it work.
 *
 * The vocabulary is deliberately not any one client's. Titles are written
 * here because tool names and argument shapes belong to Claude Code, and a
 * consumer that has never heard of `Bash` or `MultiEdit` cannot render them.
 * Icons are the one exception: the names are Slack's fixed set, because it
 * is the only consumer that draws them and it accepts nothing else.
 */

/**
 * Token a tool result carries when the call was refused because what it
 * asked for is already happening — posting into the thread the turn is
 * already answering, reading a thread the turn already carries. The step
 * leaves no card behind: nothing went wrong, and nobody was waiting on it.
 */
export const REDUNDANT_CALL = "[thicket:redundant]";

/** Artifact id carrying the activity stream of a task. */
export const ACTIVITY_ARTIFACT_ID = "agent-activity";

/** Media type of an activity data part. */
export const ACTIVITY_MEDIA_TYPE = "application/vnd.thicket.activity+json";

export type AgentActivityStatus = "running" | "done" | "failed";

/**
 * Every icon a card may carry. Anything outside this set makes Slack
 * reject the whole chunk, so unknown names are dropped rather than sent.
 */
export const ACTIVITY_ICONS = [
  "archive", "book", "bookmark", "bot", "bug", "calendar", "call", "caret-left",
  "caret-right", "check", "clipboard", "code", "comment", "compass", "copy", "cube",
  "download", "edit", "email", "eye-closed", "eye-open", "file", "flag", "folder",
  "gear", "globe", "heart", "help", "image", "info", "key", "lightbulb", "link",
  "map", "mobile", "new-window", "pin", "plus", "refine", "refresh", "rocket",
  "save", "screen", "share", "sparkle", "star", "star-filled", "tag", "thumbs-down",
  "thumbs-up", "trash", "upload", "user", "warning",
] as const;

export type AgentActivityIcon = (typeof ACTIVITY_ICONS)[number];

/** One step, updated in place: the same `id` may arrive more than once. */
export interface AgentActivity {
  id: string;
  title: string;
  status: AgentActivityStatus;
  /** Secondary line: the command, the path, the error. */
  details?: string;
  /** What kind of step this is. A card without one renders plain. */
  icon?: AgentActivityIcon;
}

/** What describeToolUse says about one tool call. */
export interface ToolDescription {
  title: string;
  details?: string;
  icon?: AgentActivityIcon;
}

const TITLE_MAX = 200;
const DETAILS_MAX = 200;

/** The icon for a tool nothing here recognises. */
const FALLBACK_ICON: AgentActivityIcon = "gear";

/** Icons for the tools agentd's own toolbelt registers (mcp__thicket__*). */
const THICKET_TOOL_ICONS: Record<string, AgentActivityIcon> = {
  post_message: "comment",
  upload_file: "upload",
  react: "heart",
  read_channel: "book",
  read_thread: "book",
  list_channels: "book",
  list_users: "user",
  search_messages: "refine",
  routine_create: "calendar",
  routine_update: "calendar",
  routine_delete: "calendar",
  routine_list: "calendar",
};

function isActivityIcon(value: unknown): value is AgentActivityIcon {
  return typeof value === "string" && (ACTIVITY_ICONS as readonly string[]).includes(value);
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function field(input: unknown, key: string): string | undefined {
  if (typeof input !== "object" || input === null) {
    return undefined;
  }
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1) || trimmed;
}

function host(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** MCP tools arrive as mcp__<server>__<tool>. */
function mcpTool(name: string): { server: string; tool: string } | undefined {
  const parts = name.split("__");
  if (parts.length < 3 || parts[0] !== "mcp") {
    return undefined;
  }
  const [, server, ...rest] = parts;
  return { server: server ?? "", tool: rest.join("__") };
}

function mcpDescription(name: string): ToolDescription {
  const mcp = mcpTool(name);
  if (mcp === undefined) {
    return { title: `Running ${name}`, icon: FALLBACK_ICON };
  }
  const icon = mcp.server === "thicket" ? THICKET_TOOL_ICONS[mcp.tool] : undefined;
  return {
    title: `${mcp.tool.replace(/_/g, " ")} (${mcp.server})`,
    icon: icon ?? FALLBACK_ICON,
  };
}

/** A human-readable heading, and an icon for the kind of step, for one tool_use block. */
export function describeToolUse(name: string, input: unknown): ToolDescription {
  const path = field(input, "file_path") ?? field(input, "notebook_path");
  switch (name) {
    case "Bash":
      return {
        title: field(input, "description") ?? "Running a command",
        details: field(input, "command"),
        icon: "code",
      };
    case "BashOutput":
      return { title: "Checking on a running command", icon: "code" };
    case "KillShell":
      return { title: "Stopping a running command", icon: "code" };
    case "Read":
      return {
        title: path === undefined ? "Reading a file" : `Reading ${basename(path)}`,
        details: path,
        icon: "file",
      };
    case "Write":
      return {
        title: path === undefined ? "Writing a file" : `Writing ${basename(path)}`,
        details: path,
        icon: "edit",
      };
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return {
        title: path === undefined ? "Editing a file" : `Editing ${basename(path)}`,
        details: path,
        icon: "edit",
      };
    case "Glob":
      return {
        title: `Looking for files matching ${field(input, "pattern") ?? "a pattern"}`,
        details: field(input, "path"),
        icon: "refine",
      };
    case "Grep":
      return {
        title: `Searching for ${field(input, "pattern") ?? "a pattern"}`,
        details: field(input, "path"),
        icon: "refine",
      };
    case "WebFetch": {
      const url = field(input, "url");
      return {
        title: url === undefined ? "Fetching a page" : `Fetching ${host(url)}`,
        details: url,
        icon: "globe",
      };
    }
    case "WebSearch":
      return { title: `Searching the web for ${field(input, "query") ?? "something"}`, icon: "globe" };
    case "Task":
    case "Agent":
      return {
        title: `Delegating to ${field(input, "subagent_type") ?? "a subagent"}`,
        details: field(input, "description"),
        icon: "bot",
      };
    case "TodoWrite":
      return { title: "Updating its plan", icon: "clipboard" };
    case "AskUserQuestion":
      return { title: "Considering a question for you", icon: "help" };
    case "Skill":
      return { title: `Using the ${field(input, "skill") ?? "a"} skill`, icon: "sparkle" };
    default:
      return mcpDescription(name);
  }
}

/** Build an activity, with every field clipped to what a card can show. */
export function activity(
  id: string,
  status: AgentActivityStatus,
  described: ToolDescription,
): AgentActivity {
  const details = described.details === undefined ? undefined : clip(described.details, DETAILS_MAX);
  return {
    id,
    title: clip(described.title, TITLE_MAX),
    status,
    ...(details === undefined || details === "" ? {} : { details }),
    ...(described.icon === undefined ? {} : { icon: described.icon }),
  };
}

/** Validate an activity arriving over the wire; undefined if malformed. */
export function parseAgentActivity(value: unknown): AgentActivity | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const { id, title, status, details, icon } = record;
  if (typeof id !== "string" || id === "" || typeof title !== "string") {
    return undefined;
  }
  if (status !== "running" && status !== "done" && status !== "failed") {
    return undefined;
  }
  return {
    id,
    title,
    status,
    ...(typeof details === "string" && details !== "" ? { details } : {}),
    // An icon this build does not know is dropped, not forwarded: the card
    // still renders, and Slack never sees a name it would reject.
    ...(isActivityIcon(icon) ? { icon } : {}),
  };
}
