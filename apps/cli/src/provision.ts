import type { SlackManifest } from "@thicket/slack-manifest";

import type { ConfigTokenPair, FileStore, ProvisionState } from "./store.js";
import { CONFIG_TOKEN_FILE, PROVISION_STATE_FILE } from "./store.js";

/**
 * The Slack app-management surface (app configuration token calls).
 * Implemented over api.slack.com in production; faked in tests.
 */
export interface SlackAdminApi {
  createApp(
    token: string,
    manifest: SlackManifest,
  ): Promise<{ appId: string; oauthAuthorizeUrl?: string }>;
  updateApp(token: string, appId: string, manifest: SlackManifest): Promise<void>;
  /** Current manifest as Slack has it, for change detection. */
  exportManifest(token: string, appId: string): Promise<SlackManifest | undefined>;
  /** tooling.tokens.rotate: exchanges the refresh token for a fresh pair. */
  rotateToken(refreshToken: string): Promise<ConfigTokenPair>;
}

export interface ProvisionInput {
  /** Desired manifests keyed by agent name, in roster order. */
  manifests: Map<string, SlackManifest>;
  /** Renderer warnings (manual icon uploads etc.). */
  warnings: string[];
  dryRun: boolean;
  /** Restrict to one agent. */
  only?: string;
}

export interface ProvisionDeps {
  api: SlackAdminApi;
  store: FileStore;
  /** Emit one operator-facing report line. Never receives a token. */
  report: (line: string) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Minimum spacing between manifest mutations (Tier 1: ~1/min). */
  mutationIntervalMs?: number;
  /** Rotate when the token has less than this long to live. */
  rotateMarginMs?: number;
}

const DEFAULT_MUTATION_INTERVAL_MS = 61_000;
const DEFAULT_ROTATE_MARGIN_MS = 10 * 60 * 1000;

/** Dotted paths at which two JSON-ish values differ. */
export function diffPaths(a: unknown, b: unknown, prefix = ""): string[] {
  if (typeof a !== typeof b || (typeof a !== "object" && a !== b) || a === null !== (b === null)) {
    return [prefix === "" ? "(root)" : prefix];
  }
  if (typeof a !== "object" || a === null || b === null) {
    return [];
  }
  const keys = new Set([
    ...Object.keys(a as Record<string, unknown>),
    ...Object.keys(b as Record<string, unknown>),
  ]);
  const out: string[] = [];
  for (const key of keys) {
    const va = (a as Record<string, unknown>)[key];
    const vb = (b as Record<string, unknown>)[key];
    const path = prefix === "" ? key : `${prefix}.${key}`;
    if (JSON.stringify(va) !== JSON.stringify(vb)) {
      out.push(...diffPaths(va, vb, path));
    }
  }
  return out;
}

export class Provisioner {
  private readonly deps: Required<
    Pick<ProvisionDeps, "now" | "sleep" | "mutationIntervalMs" | "rotateMarginMs">
  > &
    ProvisionDeps;
  private lastMutationAt = 0;

  constructor(deps: ProvisionDeps) {
    this.deps = {
      ...deps,
      now: deps.now ?? (() => Date.now()),
      sleep: deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
      mutationIntervalMs: deps.mutationIntervalMs ?? DEFAULT_MUTATION_INTERVAL_MS,
      rotateMarginMs: deps.rotateMarginMs ?? DEFAULT_ROTATE_MARGIN_MS,
    };
  }

  async run(input: ProvisionInput): Promise<{ changed: string[]; created: string[] }> {
    const state = this.deps.store.read<ProvisionState>(PROVISION_STATE_FILE) ?? { apps: {} };
    const changed: string[] = [];
    const created: string[] = [];

    for (const [agent, manifest] of input.manifests) {
      if (input.only !== undefined && agent !== input.only) {
        continue;
      }
      const known = state.apps[agent];
      if (known === undefined) {
        if (input.dryRun) {
          this.deps.report(`would create Slack app for ${agent}`);
          continue;
        }
        await this.paceMutations();
        const result = await this.deps.api.createApp(await this.freshToken(), manifest);
        state.apps[agent] = { appId: result.appId };
        this.deps.store.write(PROVISION_STATE_FILE, state);
        created.push(agent);
        this.deps.report(`created Slack app ${result.appId} for ${agent}`);
        if (result.oauthAuthorizeUrl !== undefined) {
          this.deps.report(`install ${agent}: ${result.oauthAuthorizeUrl}`);
        }
        continue;
      }

      const current = await this.deps.api.exportManifest(await this.freshToken(), known.appId);
      const drift = diffPaths(current ?? {}, manifest);
      if (drift.length === 0) {
        this.deps.report(`${agent}: up to date`);
        continue;
      }
      if (input.dryRun) {
        this.deps.report(`would update ${agent} (${known.appId}): ${drift.join(", ")}`);
        continue;
      }
      await this.paceMutations();
      await this.deps.api.updateApp(await this.freshToken(), known.appId, manifest);
      changed.push(agent);
      this.deps.report(`updated ${agent} (${known.appId}): ${drift.join(", ")}`);
    }

    for (const warning of input.warnings) {
      this.deps.report(`manual step: ${warning}`);
    }
    return { changed, created };
  }

  /**
   * App configuration tokens live 12 hours. Rotate before expiry and
   * persist the new pair immediately, so a run that dies mid-way leaves a
   * live refresh token on disk rather than a dead one.
   */
  private async freshToken(): Promise<string> {
    const pair = this.deps.store.read<ConfigTokenPair>(CONFIG_TOKEN_FILE);
    if (pair === undefined) {
      throw new Error(
        `no Slack app configuration token; write one to ${this.deps.store.path(CONFIG_TOKEN_FILE)}`,
      );
    }
    const msLeft = pair.exp * 1000 - this.deps.now();
    if (msLeft > this.deps.rotateMarginMs) {
      return pair.token;
    }
    const rotated = await this.deps.api.rotateToken(pair.refreshToken);
    this.deps.store.write(CONFIG_TOKEN_FILE, rotated, { secret: true });
    this.deps.report("rotated Slack app configuration token");
    return rotated.token;
  }

  /** apps.manifest.create/update are Tier 1 (~1/min): pace, don't burst. */
  private async paceMutations(): Promise<void> {
    const since = this.deps.now() - this.lastMutationAt;
    const wait = this.deps.mutationIntervalMs - since;
    if (this.lastMutationAt !== 0 && wait > 0) {
      this.deps.report(`pacing for Slack rate limit (${Math.ceil(wait / 1000)}s)`);
      await this.deps.sleep(wait);
    }
    this.lastMutationAt = this.deps.now();
  }
}
