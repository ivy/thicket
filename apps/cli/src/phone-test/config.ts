import { readFileSync, statSync } from "node:fs";

import { z } from "zod";

/** E.164: a plus, a non-zero country code, up to fifteen digits in all. */
const E164 = /^\+[1-9]\d{6,14}$/;
const e164 = z.string().regex(E164, { message: "must be an E.164 number (+15550100001)" });

/**
 * The synthetic operator's own config — never the bridge's `phone.json`,
 * because in deployment they are different accounts with different
 * credentials. One JSON file, mode 0600, written by the operator; `.env`
 * is where the values are parked for convenience, and nothing here reads it.
 */
const phoneTestConfigSchema = z
  .object({
    twilio: z
      .object({
        account_sid: z.string().regex(/^AC[0-9a-f]{32}$/, { message: "must be an account SID (AC…)" }),
        /** The primary auth token: the only credential that validates X-Twilio-Signature. */
        auth_token: z.string().min(1),
        /** A restricted API key for REST calls; the auth token is used when absent. */
        api_key_sid: z.string().regex(/^SK[0-9a-f]{32}$/, { message: "must be an API key SID (SK…)" }).optional(),
        api_key_secret: z.string().min(1).optional(),
      })
      .strict(),
    /** The bridge's number: what the tool dials, and the default caller id. */
    number: e164,
    /** Caller id override — a Verified Caller ID on the account, e.g. the operator's own number. */
    from: e164.optional(),
    /** The bridge's PIN, exactly eight digits; keyed, never logged or recorded. */
    pin: z.string().regex(/^\d{8}$/, { message: "the PIN is exactly eight digits" }),
    /** Where Twilio reaches the caller leg: the Funnel base URL, https only. */
    public_base_url: z
      .string()
      .regex(/^https:\/\/[^\s/]+$/, { message: "must be an https origin with no path" }),
    /** The Funnel mount path routed to this tool; the bridge owns `/`. */
    path_prefix: z
      .string()
      .regex(/^\/[a-z0-9-]+$/, { message: "must be a single path segment like /operator" })
      .default("/operator"),
    /** `host:port` the caller-leg socket listens on, behind the Funnel path. */
    listen: z
      .string()
      .regex(/^[^:\s]+:\d{1,5}$/, { message: "must be host:port" })
      .default("127.0.0.1:8797"),
    /** Where call recordings go; default under the state dir. */
    recordings_dir: z.string().min(1).optional(),
  })
  .strict();

export type PhoneTestConfig = z.infer<typeof phoneTestConfigSchema>;

export class PhoneTestConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PhoneTestConfigError";
  }
}

export function parsePhoneTestConfig(raw: string, path: string): PhoneTestConfig {
  let document: unknown;
  try {
    document = JSON.parse(raw);
  } catch {
    throw new PhoneTestConfigError(`phone-test config ${path} is not JSON`);
  }
  const result = phoneTestConfigSchema.safeParse(document);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue === undefined || issue.path.length === 0 ? "config" : issue.path.join(".");
    throw new PhoneTestConfigError(`phone-test config ${path}: ${where}: ${issue?.message ?? "invalid"}`);
  }
  return result.data;
}

export function loadPhoneTestConfig(path: string): PhoneTestConfig {
  let mode: number;
  try {
    mode = statSync(path).mode & 0o777;
  } catch {
    throw new PhoneTestConfigError(
      `no phone-test config at ${path} — write it yourself, mode 0600, with the Twilio ` +
        `credentials, the number, the PIN and the public base URL (see docs/live-testing.md)`,
    );
  }
  if ((mode & 0o077) !== 0) {
    throw new PhoneTestConfigError(
      `phone-test config ${path} is mode ${mode.toString(8).padStart(4, "0")}; it holds the PIN and tokens and must be 0600`,
    );
  }
  return parsePhoneTestConfig(readFileSync(path, "utf8"), path);
}
