import type { FileStore } from "./store.js";

/**
 * The operator's Twilio provisioning file, beside the Slack configuration
 * token: credentials for the number's settings, the number itself, and the
 * public base URL the deployed phone bridge answers on. Mode 0600, written
 * by the operator; nothing here is rendered from the roster.
 */
export const TWILIO_FILE = "twilio.json";

export interface TwilioProvisioning {
  account_sid: string;
  /** A restricted API key with active-numbers read/update; the auth token works too. */
  api_key_sid?: string;
  api_key_secret?: string;
  auth_token?: string;
  /** The number the operator dials, E.164. */
  number: string;
  /** Where the phone bridge answers: the Funnel origin, https, no path. */
  public_base_url: string;
}

export function readTwilioProvisioning(store: FileStore): TwilioProvisioning | undefined {
  const raw = store.read<Partial<TwilioProvisioning>>(TWILIO_FILE);
  if (raw === undefined) {
    return undefined;
  }
  for (const key of ["account_sid", "number", "public_base_url"] as const) {
    if (typeof raw[key] !== "string" || raw[key] === "") {
      throw new Error(`${store.path(TWILIO_FILE)}: "${key}" is required`);
    }
  }
  if ((raw.api_key_sid === undefined || raw.api_key_secret === undefined) && raw.auth_token === undefined) {
    throw new Error(`${store.path(TWILIO_FILE)}: needs api_key_sid + api_key_secret, or auth_token`);
  }
  return raw as TwilioProvisioning;
}

/** What a number's voice settings look like, on Twilio's side and on ours. */
export interface NumberSettings {
  voiceUrl: string;
  voiceMethod: string;
  statusCallback: string;
  statusCallbackMethod: string;
}

/** The settings the bridge needs: TwiML from `/voice`, call status to `/status`. */
export function desiredNumberSettings(publicBaseUrl: string): NumberSettings {
  const base = publicBaseUrl.replace(/\/$/, "");
  return {
    voiceUrl: `${base}/voice`,
    voiceMethod: "POST",
    statusCallback: `${base}/status`,
    statusCallbackMethod: "POST",
  };
}

/** Which settings differ, as `field: live → desired`. Empty means no drift. */
export function settingsDrift(live: NumberSettings, desired: NumberSettings): string[] {
  const out: string[] = [];
  for (const key of Object.keys(desired) as (keyof NumberSettings)[]) {
    if (live[key] !== desired[key]) {
      out.push(`${key}: ${live[key] === "" ? "(unset)" : live[key]} → ${desired[key]}`);
    }
  }
  return out;
}

/** The slice of Twilio's number API provisioning uses. Faked in tests. */
export interface TwilioNumberApi {
  /** The number's SID and live voice settings, or undefined when the account does not own it. */
  lookup(number: string): Promise<{ sid: string; settings: NumberSettings } | undefined>;
  update(sid: string, settings: NumberSettings): Promise<void>;
}

export class HttpTwilioNumberApi implements TwilioNumberApi {
  private readonly base: string;
  private readonly authorization: string;

  constructor(
    private readonly creds: TwilioProvisioning,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.base = `https://api.twilio.com/2010-04-01/Accounts/${creds.account_sid}`;
    const user = creds.api_key_sid ?? creds.account_sid;
    const secret = creds.api_key_sid !== undefined ? creds.api_key_secret! : creds.auth_token!;
    this.authorization = "Basic " + Buffer.from(`${user}:${secret}`).toString("base64");
  }

  async lookup(number: string) {
    const response = await this.fetchImpl(
      `${this.base}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(number)}`,
      { headers: { authorization: this.authorization } },
    );
    if (!response.ok) {
      throw new Error(`Twilio lookup of the number failed: HTTP ${response.status}`);
    }
    const body = (await response.json()) as {
      incoming_phone_numbers?: Array<{
        sid: string;
        voice_url?: string;
        voice_method?: string;
        status_callback?: string;
        status_callback_method?: string;
      }>;
    };
    const found = body.incoming_phone_numbers?.[0];
    if (found === undefined) {
      return undefined;
    }
    return {
      sid: found.sid,
      settings: {
        voiceUrl: found.voice_url ?? "",
        voiceMethod: found.voice_method ?? "",
        statusCallback: found.status_callback ?? "",
        statusCallbackMethod: found.status_callback_method ?? "",
      },
    };
  }

  async update(sid: string, settings: NumberSettings) {
    const form = new URLSearchParams({
      VoiceUrl: settings.voiceUrl,
      VoiceMethod: settings.voiceMethod,
      StatusCallback: settings.statusCallback,
      StatusCallbackMethod: settings.statusCallbackMethod,
    });
    const response = await this.fetchImpl(`${this.base}/IncomingPhoneNumbers/${sid}.json`, {
      method: "POST",
      headers: { authorization: this.authorization, "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    if (!response.ok) {
      throw new Error(`Twilio update of the number failed: HTTP ${response.status}`);
    }
  }
}

export interface PhoneProvisionDeps {
  api: TwilioNumberApi;
  /** One operator-facing line. Never a credential. */
  report: (line: string) => void;
}

/**
 * Points the number at the bridge — idempotently, and only after saying
 * what would change. The TwiML itself is the bridge's to serve; this
 * writes a URL, not markup.
 */
export async function provisionNumber(
  input: { number: string; publicBaseUrl: string; dryRun: boolean },
  deps: PhoneProvisionDeps,
): Promise<"up to date" | "changed" | "would change"> {
  const desired = desiredNumberSettings(input.publicBaseUrl);
  const live = await deps.api.lookup(input.number);
  if (live === undefined) {
    throw new Error(`the Twilio account does not own the number in ${TWILIO_FILE}`);
  }
  const drift = settingsDrift(live.settings, desired);
  if (drift.length === 0) {
    deps.report(`phone number: up to date (voice URL ${desired.voiceUrl})`);
    return "up to date";
  }
  if (input.dryRun) {
    deps.report(`would point the phone number at the bridge: ${drift.join("; ")}`);
    return "would change";
  }
  await deps.api.update(live.sid, desired);
  deps.report(`pointed the phone number at the bridge: ${drift.join("; ")}`);
  return "changed";
}
