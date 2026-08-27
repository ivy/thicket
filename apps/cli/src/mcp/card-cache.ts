import type { AgentCard } from "@a2a-js/sdk";

import type { HttpDoer } from "./http.js";

interface CacheEntry {
  card: AgentCard;
  etag?: string;
  freshUntil: number;
}

const DEFAULT_TTL_MS = 60_000;

/**
 * Agent-card cache honoring Cache-Control max-age and ETag per A2A §8.6.
 * While fresh, no request is made; on expiry a conditional request goes
 * out and a 304 revalidates without a body. A skill added to an agent
 * shows up here after expiry with no restart.
 */
export class CardCache {
  private readonly entries = new Map<string, CacheEntry>();

  constructor(
    private readonly http: HttpDoer,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async get(agent: string, cardUrl: string): Promise<AgentCard> {
    const entry = this.entries.get(agent);
    if (entry !== undefined && this.now() < entry.freshUntil) {
      return entry.card;
    }

    const headers: Record<string, string> = {};
    if (entry?.etag !== undefined) {
      headers["if-none-match"] = entry.etag;
    }
    const response = await this.http({ method: "GET", url: cardUrl, headers });

    if (response.status === 304 && entry !== undefined) {
      entry.freshUntil = this.now() + this.ttlFrom(response.headers);
      return entry.card;
    }
    if (response.status !== 200) {
      throw new Error(`agent card fetch failed: HTTP ${response.status}`);
    }
    const card = JSON.parse(response.body) as AgentCard;
    const etagHeader = response.headers.etag;
    this.entries.set(agent, {
      card,
      etag: typeof etagHeader === "string" ? etagHeader : undefined,
      freshUntil: this.now() + this.ttlFrom(response.headers),
    });
    return card;
  }

  private ttlFrom(headers: Record<string, string | string[] | undefined>): number {
    const cacheControl = headers["cache-control"];
    if (typeof cacheControl === "string") {
      const match = /max-age=(\d+)/.exec(cacheControl);
      if (match !== null) {
        return Number(match[1]) * 1000;
      }
    }
    return DEFAULT_TTL_MS;
  }
}
