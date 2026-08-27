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
    for (const [name, entry] of Object.entries(roster.agents)) {
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
