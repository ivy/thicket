/**
 * Tool activity: the steps an agent takes inside a turn, rendered for a
 * human watching it work.
 *
 * The vocabulary is deliberately not any one client's. Titles are written
 * here because tool names and argument shapes belong to Claude Code, and a
 * consumer that has never heard of `Bash` or `MultiEdit` cannot render them.
 */

/** Artifact id carrying the activity stream of a task. */
export const ACTIVITY_ARTIFACT_ID = "agent-activity";

/** Media type of an activity data part. */
export const ACTIVITY_MEDIA_TYPE = "application/vnd.thicket.activity+json";

export type AgentActivityStatus = "running" | "done" | "failed";

/** One step, updated in place: the same `id` may arrive more than once. */
export interface AgentActivity {
  id: string;
  title: string;
  status: AgentActivityStatus;
  /** Secondary line: the command, the path, the error. */
  details?: string;
}

const TITLE_MAX = 200;
const DETAILS_MAX = 200;

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
function mcpTitle(name: string): string | undefined {
  const parts = name.split("__");
  if (parts.length < 3 || parts[0] !== "mcp") {
    return undefined;
  }
  const [, server, ...rest] = parts;
  return `${rest.join(" ").replace(/_/g, " ")} (${server})`;
}

/** A human-readable heading for one tool_use block. */
export function describeToolUse(
  name: string,
  input: unknown,
): { title: string; details?: string } {
  const path = field(input, "file_path") ?? field(input, "notebook_path");
  switch (name) {
    case "Bash":
      return {
        title: field(input, "description") ?? "Running a command",
        details: field(input, "command"),
      };
    case "BashOutput":
      return { title: "Checking on a running command" };
    case "KillShell":
      return { title: "Stopping a running command" };
    case "Read":
      return { title: path === undefined ? "Reading a file" : `Reading ${basename(path)}`, details: path };
    case "Write":
      return { title: path === undefined ? "Writing a file" : `Writing ${basename(path)}`, details: path };
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return { title: path === undefined ? "Editing a file" : `Editing ${basename(path)}`, details: path };
    case "Glob":
      return {
        title: `Looking for files matching ${field(input, "pattern") ?? "a pattern"}`,
        details: field(input, "path"),
      };
    case "Grep":
      return {
        title: `Searching for ${field(input, "pattern") ?? "a pattern"}`,
        details: field(input, "path"),
      };
    case "WebFetch": {
      const url = field(input, "url");
      return { title: url === undefined ? "Fetching a page" : `Fetching ${host(url)}`, details: url };
    }
    case "WebSearch":
      return { title: `Searching the web for ${field(input, "query") ?? "something"}` };
    case "Task":
    case "Agent":
      return {
        title: `Delegating to ${field(input, "subagent_type") ?? "a subagent"}`,
        details: field(input, "description"),
      };
    case "TodoWrite":
      return { title: "Updating its plan" };
    case "AskUserQuestion":
      return { title: "Considering a question for you" };
    case "Skill":
      return { title: `Using the ${field(input, "skill") ?? "a"} skill` };
    default:
      return { title: mcpTitle(name) ?? `Running ${name}` };
  }
}

/** Build an activity, with every field clipped to what a card can show. */
export function activity(
  id: string,
  status: AgentActivityStatus,
  described: { title: string; details?: string },
): AgentActivity {
  const details = described.details === undefined ? undefined : clip(described.details, DETAILS_MAX);
  return {
    id,
    title: clip(described.title, TITLE_MAX),
    status,
    ...(details === undefined || details === "" ? {} : { details }),
  };
}

/** Validate an activity arriving over the wire; undefined if malformed. */
export function parseAgentActivity(value: unknown): AgentActivity | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const { id, title, status, details } = record;
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
  };
}
