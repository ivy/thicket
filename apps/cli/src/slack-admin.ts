import type { SlackManifest } from "@thicket/slack-manifest";

import type { SlackAdminApi } from "./provision.js";
import type { ConfigTokenPair } from "./store.js";

interface SlackResponse {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

/**
 * SlackAdminApi over api.slack.com. Token values travel only in request
 * bodies; errors are surfaced by Slack's error code, never echoing the
 * token.
 */
export class HttpSlackAdminApi implements SlackAdminApi {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  private async call(method: string, body: Record<string, unknown>): Promise<SlackResponse> {
    const response = await this.fetchImpl(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(body),
    });
    const payload = (await response.json()) as SlackResponse;
    if (!payload.ok) {
      throw new Error(`${method} failed: ${payload.error ?? "unknown_error"}`);
    }
    return payload;
  }

  async createApp(token: string, manifest: SlackManifest) {
    const res = await this.call("apps.manifest.create", {
      token,
      manifest: JSON.stringify(manifest),
    });
    const appId = String(res.app_id ?? "");
    if (appId === "") {
      throw new Error("apps.manifest.create returned no app_id");
    }
    return {
      appId,
      oauthAuthorizeUrl:
        typeof res.oauth_authorize_url === "string" ? res.oauth_authorize_url : undefined,
    };
  }

  async updateApp(token: string, appId: string, manifest: SlackManifest): Promise<void> {
    await this.call("apps.manifest.update", {
      token,
      app_id: appId,
      manifest: JSON.stringify(manifest),
    });
  }

  async exportManifest(token: string, appId: string): Promise<SlackManifest | undefined> {
    try {
      const res = await this.call("apps.manifest.export", { token, app_id: appId });
      return res.manifest as SlackManifest | undefined;
    } catch {
      return undefined;
    }
  }

  async rotateToken(refreshToken: string): Promise<ConfigTokenPair> {
    const res = await this.call("tooling.tokens.rotate", { refresh_token: refreshToken });
    return {
      token: String(res.token ?? ""),
      refreshToken: String(res.refresh_token ?? ""),
      exp: Number(res.exp ?? 0),
    };
  }
}
