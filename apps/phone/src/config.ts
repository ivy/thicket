import { readFileSync, statSync } from "node:fs";

import { z } from "zod";

/** E.164: a plus, a non-zero country code, up to fifteen digits in all. */
const E164 = /^\+[1-9]\d{6,14}$/;
const e164 = z.string().regex(E164, { message: "must be an E.164 number (+15550100001)" });

/**
 * The phone bridge's own config: everything about the phone that is a
 * secret or an identifier, which is exactly what the roster must never
 * hold. One JSON file beside the Slack bridge's, mode 0600, written by
 * the operator like every token. `.env` is where the operator parks these
 * values for convenience; nothing here reads it.
 */
const phoneConfigSchema = z
  .object({
    /** Roster to read; default $XDG_CONFIG_HOME/thicket/agents.yaml. */
    agents_file: z.string().min(1).optional(),
    /** State database; default under the state dir. */
    db_path: z.string().min(1).optional(),
    /** Unix socket the server listens on, for netd to front; default under the runtime dir. */
    socket_path: z.string().min(1).optional(),
    /** `host:port` to listen on TCP instead — the dev rig, behind `tailscale funnel`. */
    listen: z.string().regex(/^[^:\s]+:\d{1,5}$/, { message: "must be host:port" }).optional(),
    /** Where Twilio reaches the bridge: the Funnel base URL, https only. */
    public_base_url: z
      .string()
      .regex(/^https:\/\/[^\s/]+$/, { message: "must be an https origin with no path" }),
    twilio: z
      .object({
        account_sid: z.string().regex(/^AC[0-9a-f]{32}$/, { message: "must be an account SID (AC…)" }),
        /** The primary auth token: the only credential that validates X-Twilio-Signature. */
        auth_token: z.string().min(1),
        /** A restricted API key for REST calls; the auth token is used when absent. */
        api_key_sid: z.string().regex(/^SK[0-9a-f]{32}$/, { message: "must be an API key SID (SK…)" }).optional(),
        api_key_secret: z.string().min(1).optional(),
        /** The number the operator dials. */
        number: e164,
      })
      .strict(),
    /** Who may call at all; the PIN is the gate, this is the pre-filter. */
    operator_numbers: z.array(e164).min(1, { message: "at least one operator number is required" }),
    /** Eight digits, compared in constant time by the bridge, never logged. */
    pin: z.string().regex(/^\d{8}$/, { message: "the PIN is exactly eight digits" }),
    /** The security-alerts channel and a bot token that may post there. */
    alerts: z
      .object({
        channel: z.string().regex(/^[CG][A-Z0-9]{8,}$/, { message: "must be a channel id (C…/G…)" }),
        bot_token: z.string().min(1),
      })
      .strict()
      .optional(),
  })
  .strict();

export type PhoneConfig = z.infer<typeof phoneConfigSchema>;

export class PhoneConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PhoneConfigError";
  }
}

function formatPath(path: PropertyKey[]): string {
  let out = "";
  for (const segment of path) {
    out += typeof segment === "number" ? `[${segment}]` : out === "" ? String(segment) : `.${String(segment)}`;
  }
  return out === "" ? "(root)" : out;
}

/** Validate an already-parsed document. `source` names the file in errors. */
export function parsePhoneConfig(document: unknown, source: string): PhoneConfig {
  const result = phoneConfigSchema.safeParse(document);
  if (!result.success) {
    const lines = result.error.issues.map((issue) => `  ${formatPath(issue.path)}: ${issue.message}`);
    throw new PhoneConfigError(`phone config ${source} is invalid:\n${lines.join("\n")}`);
  }
  return result.data;
}

/**
 * Read and validate the config file. Refuses a file readable by anyone
 * but its owner: the PIN and the tokens are in it, and a bridge that
 * starts on a 0644 file has already leaked them to every local user.
 */
export function loadPhoneConfig(path: string): PhoneConfig {
  let mode: number;
  let text: string;
  try {
    mode = statSync(path).mode & 0o777;
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new PhoneConfigError(
      `phone config ${path} cannot be read: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if ((mode & 0o077) !== 0) {
    throw new PhoneConfigError(
      `phone config ${path} is mode ${mode.toString(8).padStart(4, "0")}; it holds the PIN and tokens and must be 0600`,
    );
  }
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch (err) {
    throw new PhoneConfigError(
      `phone config ${path} is not JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return parsePhoneConfig(document, path);
}
