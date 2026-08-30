import { parse as parseYaml } from "yaml";
import { z } from "zod";

const skillSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  tags: z.array(z.string().min(1)).default([]),
  examples: z.array(z.string().min(1)).default([]),
});

const harnessSchema = z.object({
  type: z.literal("claude-agent-sdk"),
  cwd: z.string().min(1),
  model: z.string().min(1),
  sessionTtlSeconds: z.number().int().positive().default(300),
  // Headless sessions have no permission prompt surface, so an 'ask'
  // decision is a terminal denial. 'auto' routes prompts through the
  // model classifier, letting agents handle administrative work;
  // 'bypassPermissions' is deliberately not offered.
  permissionMode: z
    .enum(["default", "acceptEdits", "plan", "dontAsk", "auto"])
    .default("auto"),
  // A file a human uploads is attacker-controlled content in the same
  // sense email is, so an agent holding privilege can refuse it at the
  // door rather than relying on the operator to remember.
  attachments: z.enum(["accept", "reject"]).default("accept"),
});

const WORKSPACE_NAME = /^[a-z0-9][a-z0-9-]*$/;
const workspaceNameSchema = z.string().regex(WORKSPACE_NAME, {
  message: "workspace names must be lowercase slugs ([a-z0-9-])",
});

/** A binding key the operator writes: a readable `#name`, or an id that never drifts. */
const CHANNEL_KEY = /^(#[a-z0-9][a-z0-9._-]*|[CG][A-Z0-9]{8,})$/;

/**
 * Whether the phone reaches this agent, and what it is called out loud.
 * Capability only: numbers, PINs, and tokens live in the phone bridge's
 * own 0600 config, never here — the roster is in git. Strict, so a
 * number that wanders in is refused rather than silently kept.
 */
const phoneSchema = z
  .object({
    /** Off unless the operator says so: putting an agent on the phone is a deliberate line. */
    enabled: z.boolean().default(false),
    /** How Aiva says the agent's name; required once enabled. */
    spokenName: z.string().trim().min(1).optional(),
    /** Other things the operator might call it; unique across the roster. */
    aliases: z.array(z.string().trim().min(1)).default([]),
    /** How long after a call ends its session is still offered for resumption. */
    resumeWindowSeconds: z
      .number()
      .int()
      .positive()
      .default(24 * 60 * 60),
  })
  .strict();

const agentEntrySchema = z.object({
  host: z.string().min(1),
  user: z.string().min(1),
  description: z.string().min(1),
  tag: z
    .string()
    .regex(/^tag:thicket-[a-z0-9][a-z0-9-]*$/, {
      message: "must look like tag:thicket-<name>",
    }),
  icon: z.string().optional(),
  /**
   * Prompt appendix for the agent's sessions — behaviour, not capability.
   * Appended to the harness's own system prompt, never replacing it. A
   * paragraph or two; anything larger belongs in the account's CLAUDE.md.
   */
  persona: z.string().min(1).optional(),
  skills: z.array(skillSchema).default([]),
  harness: harnessSchema,
  context: z.enum(["native", "replay"]).default("native"),
  queueing: z.enum(["harness", "bridge"]).default("harness"),
  /**
   * Working directories a conversation can be bound to, by name. The
   * agent's own half of a channel binding: the bridge never learns a
   * path, only the name.
   */
  workspaces: z
    .record(z.string(), z.string().regex(/^\//, { message: "workspace paths must be absolute" }))
    .default({}),
  /**
   * Channel → workspace name. A mention there runs in that workspace, so
   * the repo's own CLAUDE.md, skills, and memory are the channel's context.
   * Keys are checked in the roster refinement, where the message can say
   * what a key should look like.
   */
  channels: z.record(z.string(), workspaceNameSchema).default({}),
  phone: phoneSchema.default({ enabled: false, aliases: [], resumeWindowSeconds: 24 * 60 * 60 }),
});

const agentNameSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*$/, {
    message: "agent names must be lowercase slugs ([a-z0-9-])",
  });

const rosterSchema = z
  .object({
    agents: z.record(agentNameSchema, agentEntrySchema),
  })
  .superRefine((roster, ctx) => {
    const byTag = new Map<string, string>();
    const byHostUser = new Map<string, string>();
    const bySpokenHandle = new Map<string, string>();
    for (const [name, entry] of Object.entries(roster.agents)) {
      if (entry.phone.enabled && entry.phone.spokenName === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["agents", name, "phone", "spokenName"],
          message: "a phone-enabled agent needs a spokenName",
        });
      }
      // Spoken names and aliases share one namespace: the operator says a
      // word and exactly one agent may answer to it.
      const handles: Array<[string, PropertyKey[]]> = [];
      if (entry.phone.spokenName !== undefined) {
        handles.push([entry.phone.spokenName, ["agents", name, "phone", "spokenName"]]);
      }
      entry.phone.aliases.forEach((alias, i) => handles.push([alias, ["agents", name, "phone", "aliases", i]]));
      for (const [handle, path] of handles) {
        const key = handle.toLowerCase();
        const owner = bySpokenHandle.get(key);
        if (owner !== undefined && owner !== name) {
          ctx.addIssue({
            code: "custom",
            path,
            message: `duplicate spoken name "${handle}" (also used by agents.${owner})`,
          });
        } else {
          bySpokenHandle.set(key, name);
        }
      }

      const tagOwner = byTag.get(entry.tag);
      if (tagOwner !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["agents", name, "tag"],
          message: `duplicate tag ${entry.tag} (also used by agents.${tagOwner})`,
        });
      } else {
        byTag.set(entry.tag, name);
      }

      for (const workspace of Object.keys(entry.workspaces)) {
        if (!WORKSPACE_NAME.test(workspace)) {
          ctx.addIssue({
            code: "custom",
            path: ["agents", name, "workspaces", workspace],
            message: "workspace names must be lowercase slugs ([a-z0-9-])",
          });
        }
      }
      for (const [channel, workspace] of Object.entries(entry.channels)) {
        if (!CHANNEL_KEY.test(channel)) {
          ctx.addIssue({
            code: "custom",
            path: ["agents", name, "channels", channel],
            message: "channel keys are #name or a channel id (C…/G…)",
          });
          continue;
        }
        if (entry.workspaces[workspace] === undefined) {
          ctx.addIssue({
            code: "custom",
            path: ["agents", name, "channels", channel],
            message: `binds to workspace "${workspace}", which agents.${name}.workspaces does not declare`,
          });
        }
      }

      const hostUser = `${entry.host}/${entry.user}`;
      const hostUserOwner = byHostUser.get(hostUser);
      if (hostUserOwner !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["agents", name],
          message: `duplicate (host, user) pair (${entry.host}, ${entry.user}) (also used by agents.${hostUserOwner})`,
        });
      } else {
        byHostUser.set(hostUser, name);
      }
    }
  });

export type AgentPhone = z.infer<typeof phoneSchema>;
export type AgentSkillEntry = z.infer<typeof skillSchema>;
export type AgentHarness = z.infer<typeof harnessSchema>;
export type AgentEntry = z.infer<typeof agentEntrySchema>;
export type Roster = z.infer<typeof rosterSchema>;

export class RosterValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RosterValidationError";
  }
}

function formatPath(path: PropertyKey[]): string {
  let out = "";
  for (const segment of path) {
    if (typeof segment === "number") {
      out += `[${segment}]`;
    } else {
      out += out === "" ? String(segment) : `.${String(segment)}`;
    }
  }
  return out === "" ? "(root)" : out;
}

/** Validate an already-parsed document against the roster schema. */
export function validateRoster(document: unknown): Roster {
  const result = rosterSchema.safeParse(document);
  if (!result.success) {
    const lines = result.error.issues.map(
      (issue) => `${formatPath(issue.path)}: ${issue.message}`,
    );
    throw new RosterValidationError(
      `invalid roster:\n${lines.map((l) => `  ${l}`).join("\n")}`,
    );
  }
  return result.data;
}

/** Parse and validate agents.yaml source text. */
export function parseRoster(yamlText: string): Roster {
  let document: unknown;
  try {
    document = parseYaml(yamlText, { uniqueKeys: true });
  } catch (err) {
    throw new RosterValidationError(
      `invalid roster: not parseable as YAML: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return validateRoster(document);
}
