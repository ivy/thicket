import type { SlackManifest } from "@thicket/slack-manifest";

import type { SlackAdminApi } from "./provision.js";
import type { ConfigTokenPair } from "./store.js";

interface SlackResponse {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

/**
 * SlackAdminApi over api.slack.com. The token travels in the
 * Authorization header — Slack ignores a token field inside a JSON body
 * (observed: not_authed) — and parameters go form-encoded, the Web API's
 * native dialect. Errors surface Slack's error code, never the token.
 */
export class HttpSlackAdminApi implements SlackAdminApi {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  private async call(
    method: string,
    params: Record<string, string>,
    token?: string,
  ): Promise<SlackResponse> {
    const response = await this.fetchImpl(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...(token !== undefined ? { authorization: `Bearer ${token}` } : {}),
      },
      body: new URLSearchParams(params).toString(),
    });
    const payload = (await response.json()) as SlackResponse;
    if (!payload.ok) {
      // Manifest validation failures carry a detailed errors array; an
      // actionable message beats a bare error code.
      const detail =
        payload.errors !== undefined ? ` — ${JSON.stringify(payload.errors)}` : "";
      throw new Error(`${method} failed: ${payload.error ?? "unknown_error"}${detail}`);
    }
    return payload;
  }

  async createApp(token: string, manifest: SlackManifest) {
    const res = await this.call(
      "apps.manifest.create",
      { manifest: JSON.stringify(manifest) },
      token,
    );
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
    await this.call(
      "apps.manifest.update",
      { app_id: appId, manifest: JSON.stringify(manifest) },
      token,
    );
  }

  async exportManifest(token: string, appId: string): Promise<SlackManifest | undefined> {
    try {
      const res = await this.call("apps.manifest.export", { app_id: appId }, token);
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
