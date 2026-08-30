/**
 * The slice of Twilio's REST API the synthetic operator uses: place the
 * self-call whose caller leg runs our ConversationRelay session, and end
 * a call from the REST side. Injectable so tests never dial anything.
 */

export interface CreateCallOptions {
  /** Inline TwiML for the caller leg — `<Connect><ConversationRelay …>`. */
  twiml: string;
  /** Post-dial digits, what a saved contact's `,<pin>` does. Never logged by callers of this port. */
  sendDigits?: string;
  statusCallback: string;
  /** Caller-id override for one call — the unlisted-caller scenario. */
  from?: string;
}

export interface TwilioRestPort {
  /** Returns the caller leg's call SID; the inbound leg gets its own. */
  createCall(options: CreateCallOptions): Promise<string>;
  completeCall(sid: string): Promise<void>;
}

export class TwilioRestError extends Error {
  constructor(
    readonly status: number,
    readonly code: unknown,
    message: string,
  ) {
    super(`Twilio REST ${status}${code === undefined ? "" : ` code ${String(code)}`}: ${message}`);
    this.name = "TwilioRestError";
  }
}

export interface HttpTwilioRestOptions {
  accountSid: string;
  authToken: string;
  apiKeySid?: string;
  apiKeySecret?: string;
  /** The number dialled — and, absent `from`, the caller id too. */
  to: string;
  from?: string;
  fetchImpl?: typeof fetch;
}

export class HttpTwilioRest implements TwilioRestPort {
  private readonly fetchImpl: typeof fetch;
  private readonly authorization: string;
  private readonly base: string;

  constructor(private readonly options: HttpTwilioRestOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    const user = options.apiKeySid ?? options.accountSid;
    const secret = options.apiKeySid !== undefined ? (options.apiKeySecret ?? "") : options.authToken;
    this.authorization = "Basic " + Buffer.from(`${user}:${secret}`).toString("base64");
    this.base = `https://api.twilio.com/2010-04-01/Accounts/${options.accountSid}`;
  }

  private async post(path: string, body: URLSearchParams): Promise<Record<string, unknown>> {
    const res = await this.fetchImpl(`${this.base}${path}`, {
      method: "POST",
      headers: { authorization: this.authorization },
      body,
    });
    const json = (await res.json()) as Record<string, unknown>;
    if (!res.ok) {
      throw new TwilioRestError(res.status, json.code, String(json.message ?? "request failed"));
    }
    return json;
  }

  async createCall(options: CreateCallOptions): Promise<string> {
    const body = new URLSearchParams({
      To: this.options.to,
      From: options.from ?? this.options.from ?? this.options.to,
      Twiml: options.twiml,
      StatusCallback: options.statusCallback,
      StatusCallbackMethod: "POST",
      ...(options.sendDigits === undefined ? {} : { SendDigits: options.sendDigits }),
    });
    for (const event of ["initiated", "ringing", "answered", "completed"]) {
      body.append("StatusCallbackEvent", event);
    }
    const json = await this.post("/Calls.json", body);
    return String(json.sid);
  }

  async completeCall(sid: string): Promise<void> {
    await this.post(`/Calls/${sid}.json`, new URLSearchParams({ Status: "completed" }));
  }
}
