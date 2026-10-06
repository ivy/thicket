import type { EngineLogger } from "./types.js";

export const API_URL = "https://discord.com/api/v10";

/** Rate limits as Discord reports them on every response. */
interface Bucket {
  remaining: number;
  /** Epoch ms at which `remaining` is whole again. */
  resetAt: number;
}

/** A refusal Discord explained: the status and its error body. */
export class DiscordApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: number | undefined,
    readonly body: unknown,
    message: string,
  ) {
    super(message);
    this.name = "DiscordApiError";
  }
}

/**
 * Fleet-wide, because the ban is: 10,000 invalid responses in ten minutes
 * from one IP, and every bot leaves through the one bridge netd. The
 * breaker trips far below that and names the bot, so one agent's bad loop
 * costs its own calls rather than the fleet's address.
 */
export class InvalidResponseBreaker {
  private readonly stamps: number[] = [];
  constructor(
    private readonly limit = 1_000,
    private readonly windowMs = 10 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  record(): void {
    this.stamps.push(this.now());
  }

  /** How many invalid responses the window currently holds. */
  count(): number {
    const floor = this.now() - this.windowMs;
    while (this.stamps.length > 0 && this.stamps[0]! < floor) {
      this.stamps.shift();
    }
    return this.stamps.length;
  }

  tripped(): boolean {
    return this.count() >= this.limit;
  }
}

export interface Multipart {
  contentType: string;
  body: Uint8Array;
}

export interface UploadFile {
  name: string;
  bytes: Uint8Array;
  contentType: string;
}

/**
 * A multipart body by hand: the egress fetch takes strings and bytes only,
 * and Discord's upload shape is `payload_json` beside `files[n]`, with the
 * message's `attachments` array naming each by index.
 */
export function multipart(payload: unknown, files: UploadFile[]): Multipart {
  const boundary = `----thicket${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [
    enc.encode(
      `--${boundary}\r\ncontent-disposition: form-data; name="payload_json"\r\n` +
        `content-type: application/json\r\n\r\n${JSON.stringify(payload)}\r\n`,
    ),
  ];
  files.forEach((file, i) => {
    const name = file.name.replaceAll('"', "");
    parts.push(
      enc.encode(
        `--${boundary}\r\ncontent-disposition: form-data; name="files[${i}]"; filename="${name}"\r\n` +
          `content-type: ${file.contentType}\r\n\r\n`,
      ),
      file.bytes,
      enc.encode("\r\n"),
    );
  });
  parts.push(enc.encode(`--${boundary}--\r\n`));
  const body = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    body.set(part, offset);
    offset += part.length;
  }
  return { contentType: `multipart/form-data; boundary=${boundary}`, body };
}

export interface RestOptions {
  token: string;
  /** Production passes a fetch that leaves through netd. */
  fetchImpl: typeof fetch;
  breaker?: InvalidResponseBreaker;
  logger?: EngineLogger;
  apiUrl?: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** The global budget: 50 a second per bot, per the docs. */
  globalPerSecond?: number;
  /** How many times a 429 is waited out before the call fails. */
  maxRetries?: number;
}

export interface RestRequest {
  body?: unknown;
  multipart?: Multipart;
  /** `X-Audit-Log-Reason`, shown in the server's audit log beside the change. */
  reason?: string;
}

export interface RestResponse<T = unknown> {
  status: number;
  body: T;
}

/**
 * A number in a path that is not a major parameter: Discord keys its buckets
 * by channel, guild and webhook id and shares them across everything else,
 * so a message id must not split one bucket into a thousand.
 */
function routeKey(method: string, path: string): string {
  const generic = path.replace(
    /\/(channels|guilds|webhooks)\/(\d{17,20})|\/\d{17,20}/g,
    (whole, major: string | undefined, id: string | undefined) =>
      major !== undefined ? `/${major}/${id}` : "/:id",
  );
  // Interaction and webhook tokens sit in the path too; they are not ids.
  return `${method} ${generic.replace(/\/[A-Za-z0-9_-]{40,}/g, "/:token")}`;
}

/**
 * Discord's REST surface for one bot, with the limits Discord reports kept
 * rather than guessed. Every response's `X-RateLimit-*` headers update the
 * route's bucket; a call on an empty bucket waits for the reset before it
 * is sent; a 429 is waited out by `retry_after` and retried a bounded
 * number of times. Nothing here is hardcoded past the global budget the
 * docs state, and even that is a ceiling the headers tighten.
 *
 * Every call is logged by shape — method, route, status, the bucket's
 * remaining — and never by content.
 */
export class DiscordRest {
  private readonly buckets = new Map<string, Bucket>();
  private readonly globalStamps: number[] = [];
  private readonly options: RestOptions;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: RestOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async get<T = unknown>(path: string): Promise<T> {
    return (await this.request<T>("GET", path)).body;
  }

  async post<T = unknown>(path: string, body?: unknown, request: RestRequest = {}): Promise<T> {
    return (await this.request<T>("POST", path, { ...request, body })).body;
  }

  async patch<T = unknown>(path: string, body?: unknown, request: RestRequest = {}): Promise<T> {
    return (await this.request<T>("PATCH", path, { ...request, body })).body;
  }

  async put<T = unknown>(path: string, body?: unknown): Promise<T> {
    return (await this.request<T>("PUT", path, { body })).body;
  }

  async delete(path: string): Promise<void> {
    await this.request("DELETE", path);
  }

  /** The call itself. Throws DiscordApiError on any 4xx or 5xx that is not waited out. */
  async request<T = unknown>(method: string, path: string, request: RestRequest = {}): Promise<RestResponse<T>> {
    const key = routeKey(method, path);
    const retries = this.options.maxRetries ?? 3;
    for (let attempt = 0; ; attempt += 1) {
      if (this.options.breaker?.tripped() === true) {
        throw new DiscordApiError(0, undefined, undefined, "invalid-response breaker tripped; calls refused until the window clears");
      }
      await this.waitForBucket(key);
      await this.waitForGlobal();
      const started = this.now();
      const response = await this.options.fetchImpl(`${this.options.apiUrl ?? API_URL}${path}`, {
        method,
        headers: this.headers(request),
        body: request.multipart?.body ?? (request.body === undefined ? undefined : JSON.stringify(request.body)),
      });
      const bucket = this.learn(key, response.headers);
      const text = await response.text();
      const body = parseBody(text);
      this.options.logger?.info("discord api", {
        method,
        route: key,
        status: response.status,
        ms: this.now() - started,
        remaining: bucket?.remaining,
      });
      if (response.status === 429) {
        this.options.breaker?.record();
        const retryAfter = retryAfterSeconds(body, response.headers);
        if (attempt >= retries) {
          throw new DiscordApiError(429, undefined, body, `rate limited on ${key}; gave up after ${attempt + 1} tries`);
        }
        this.options.logger?.warn("discord rate limited; waiting", {
          route: key,
          retryAfter,
          scope: response.headers.get("x-ratelimit-scope"),
        });
        await this.sleep(retryAfter * 1000);
        continue;
      }
      if (response.status === 401 || response.status === 403) {
        this.options.breaker?.record();
      }
      if (!response.ok) {
        const error = body as { message?: string; code?: number } | null;
        throw new DiscordApiError(
          response.status,
          error?.code,
          body,
          `discord ${method} ${key}: ${response.status} ${error?.message ?? ""}`.trim(),
        );
      }
      return { status: response.status, body: body as T };
    }
  }

  private headers(request: RestRequest): Record<string, string> {
    const headers: Record<string, string> = {
      authorization: `Bot ${this.options.token}`,
      "user-agent": "DiscordBot (https://github.com/ivy/thicket, thicket)",
    };
    if (request.multipart !== undefined) {
      headers["content-type"] = request.multipart.contentType;
    } else if (request.body !== undefined) {
      headers["content-type"] = "application/json";
    }
    if (request.reason !== undefined) {
      headers["x-audit-log-reason"] = encodeURIComponent(request.reason);
    }
    return headers;
  }

  private async waitForBucket(key: string): Promise<void> {
    const bucket = this.buckets.get(key);
    if (bucket === undefined || bucket.remaining > 0) {
      return;
    }
    const wait = bucket.resetAt - this.now();
    if (wait > 0) {
      this.options.logger?.info("discord bucket empty; waiting", { route: key, ms: wait });
      await this.sleep(wait);
    }
    bucket.remaining = 1;
  }

  private async waitForGlobal(): Promise<void> {
    const limit = this.options.globalPerSecond ?? 50;
    const floor = this.now() - 1000;
    while (this.globalStamps.length > 0 && this.globalStamps[0]! < floor) {
      this.globalStamps.shift();
    }
    if (this.globalStamps.length >= limit) {
      await this.sleep(this.globalStamps[0]! + 1000 - this.now());
    }
    this.globalStamps.push(this.now());
  }

  private learn(key: string, headers: Headers): Bucket | undefined {
    const remaining = headers.get("x-ratelimit-remaining");
    const resetAfter = headers.get("x-ratelimit-reset-after");
    if (remaining === null || resetAfter === null) {
      return undefined;
    }
    const bucket: Bucket = {
      remaining: Number(remaining),
      resetAt: this.now() + Number(resetAfter) * 1000,
    };
    this.buckets.set(key, bucket);
    return bucket;
  }
}

function parseBody(text: string): unknown {
  if (text === "") {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function retryAfterSeconds(body: unknown, headers: Headers): number {
  const fromBody = (body as { retry_after?: unknown } | null)?.retry_after;
  if (typeof fromBody === "number") {
    return fromBody;
  }
  const header = headers.get("retry-after");
  return header === null ? 1 : Number(header);
}
