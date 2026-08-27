import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SlackManifest } from "@thicket/slack-manifest";

import { Provisioner, diffPaths, type SlackAdminApi } from "./provision.js";
import {
  CONFIG_TOKEN_FILE,
  FileStore,
  PROVISION_STATE_FILE,
  type ConfigTokenPair,
} from "./store.js";

const TOKEN_A = "xoxe.xoxp-token-alpha";
const TOKEN_B = "xoxe.xoxp-token-bravo";
const REFRESH_A = "xoxe-refresh-alpha";
const REFRESH_B = "xoxe-refresh-bravo";

function manifest(description: string): SlackManifest {
  return {
    display_information: {
      name: "x",
      description,
      long_description: description.repeat(10),
    },
    features: {
      bot_user: { display_name: "x", always_online: true },
      agent_view: { agent_description: description, suggested_prompts: [], actions: [] },
    },
    oauth_config: { scopes: { bot: [] } },
    settings: {
      org_deploy_enabled: false,
      socket_mode_enabled: true,
      token_rotation_enabled: false,
      event_subscriptions: { bot_events: [] },
    },
  };
}

/**
 * Fake Slack admin API enforcing the two real-world hazards: Tier 1 rate
 * limiting on manifest mutations and 12-hour token expiry.
 */
class FakeSlackAdmin implements SlackAdminApi {
  apps = new Map<string, SlackManifest>();
  creates = 0;
  updates = 0;
  rotations = 0;
  private lastMutationAt = -Infinity;
  private appCounter = 0;
  validToken = TOKEN_A;
  tokenExp: number;

  constructor(private readonly clock: { now: number }, tokenExpMs: number) {
    this.tokenExp = tokenExpMs;
  }

  private checkToken(token: string): void {
    if (token !== this.validToken || this.clock.now >= this.tokenExp) {
      throw new Error("invalid_auth: token expired or wrong");
    }
  }

  private checkRate(): void {
    if (this.clock.now - this.lastMutationAt < 60_000) {
      throw new Error("ratelimited");
    }
    this.lastMutationAt = this.clock.now;
  }

  async createApp(token: string, m: SlackManifest) {
    this.checkToken(token);
    this.checkRate();
    this.creates += 1;
    const appId = `A${++this.appCounter}`;
    this.apps.set(appId, m);
    return { appId, oauthAuthorizeUrl: `https://slack.com/oauth/authorize?app=${appId}` };
  }

  async updateApp(token: string, appId: string, m: SlackManifest) {
    this.checkToken(token);
    this.checkRate();
    this.updates += 1;
    this.apps.set(appId, m);
  }

  async exportManifest(token: string, appId: string) {
    this.checkToken(token);
    const stored = this.apps.get(appId);
    if (stored === undefined) {
      return undefined;
    }
    // The real apps.manifest.export returns the manifest as Slack stores
    // it, including keys the caller never sent (observed live:
    // pkce_enabled, is_mcp_enabled, interactivity). Mimic that so the
    // idempotency tests exercise the projection.
    // ...and actions is write-only: accepted on create/update, never
    // present in the export.
    const { actions: _actions, ...agentView } = stored.features.agent_view;
    return {
      ...stored,
      features: { ...stored.features, agent_view: agentView },
      oauth_config: { ...stored.oauth_config, pkce_enabled: false },
      settings: {
        ...stored.settings,
        is_mcp_enabled: false,
        interactivity: { is_enabled: false },
      },
    } as unknown as SlackManifest;
  }

  async rotateToken(refreshToken: string): Promise<ConfigTokenPair> {
    assert.equal(refreshToken, this.rotations === 0 ? REFRESH_A : REFRESH_B);
    this.rotations += 1;
    this.validToken = TOKEN_B;
    this.tokenExp = this.clock.now + 12 * 3600 * 1000;
    return { token: TOKEN_B, refreshToken: REFRESH_B, exp: this.tokenExp / 1000 };
  }
}

interface Rig {
  provisioner: Provisioner;
  api: FakeSlackAdmin;
  store: FileStore;
  clock: { now: number };
  lines: string[];
  sleeps: number[];
  dir: string;
}

function rig(options: { tokenTtlMs?: number; rotateMarginMs?: number } = {}): Rig {
  const dir = mkdtempSync(join(tmpdir(), "cli-"));
  const clock = { now: 1_000_000_000_000 };
  const api = new FakeSlackAdmin(clock, clock.now + (options.tokenTtlMs ?? 12 * 3600 * 1000));
  const store = new FileStore(dir);
  store.write(
    CONFIG_TOKEN_FILE,
    {
      token: TOKEN_A,
      refreshToken: REFRESH_A,
      exp: (clock.now + (options.tokenTtlMs ?? 12 * 3600 * 1000)) / 1000,
    } satisfies ConfigTokenPair,
    { secret: true },
  );
  const lines: string[] = [];
  const sleeps: number[] = [];
  const provisioner = new Provisioner({
    api,
    store,
    report: (line) => lines.push(line),
    now: () => clock.now,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock.now += ms;
    },
    mutationIntervalMs: 61_000,
    rotateMarginMs: options.rotateMarginMs ?? 10 * 60 * 1000,
  });
  return { provisioner, api, store, clock, lines, sleeps, dir };
}

function manifests(...descriptions: [string, string][]): Map<string, SlackManifest> {
  return new Map(descriptions.map(([name, desc]) => [name, manifest(desc)]));
}

test("dry-run prints the diff and makes no mutating calls", async (t) => {
  const r = rig();
  t.after(() => rmSync(r.dir, { recursive: true, force: true }));

  await r.provisioner.run({
    manifests: manifests(["hearth", "personal assistant"]),
    warnings: [],
    dryRun: true,
  });
  assert.ok(r.lines.some((l) => l.includes("would create Slack app for hearth")));
  assert.equal(r.api.creates + r.api.updates, 0);

  // Provision for real, drift the description, dry-run again: diff named.
  await r.provisioner.run({
    manifests: manifests(["hearth", "personal assistant"]),
    warnings: [],
    dryRun: false,
  });
  r.lines.length = 0;
  await r.provisioner.run({
    manifests: manifests(["hearth", "sharper description"]),
    warnings: [],
    dryRun: true,
  });
  const diffLine = r.lines.find((l) => l.includes("would update hearth"));
  assert.ok(diffLine, r.lines.join("\n"));
  assert.match(diffLine, /display_information\.description/);
  assert.equal(r.api.updates, 0, "dry-run mutated nothing");
});

test("provision twice with an unchanged roster is a no-op", async (t) => {
  const r = rig();
  t.after(() => rmSync(r.dir, { recursive: true, force: true }));
  const input = {
    manifests: manifests(["hearth", "personal assistant"], ["forge", "ci fixer"]),
    warnings: [],
    dryRun: false,
  };
  await r.provisioner.run(input);
  assert.equal(r.api.creates, 2);

  await r.provisioner.run(input);
  assert.equal(r.api.creates, 2, "no re-create");
  assert.equal(r.api.updates, 0, "no spurious update");
  assert.equal(r.lines.filter((l) => l.includes("up to date")).length, 2);
});

test("changing one agent's description updates only that app", async (t) => {
  const r = rig();
  t.after(() => rmSync(r.dir, { recursive: true, force: true }));
  await r.provisioner.run({
    manifests: manifests(["hearth", "personal assistant"], ["forge", "ci fixer"]),
    warnings: [],
    dryRun: false,
  });

  await r.provisioner.run({
    manifests: manifests(["hearth", "personal assistant"], ["forge", "ci fixer v2"]),
    warnings: [],
    dryRun: false,
  });
  assert.equal(r.api.updates, 1, "exactly one update");
  assert.ok(r.lines.some((l) => l.startsWith("updated forge")));
  assert.ok(!r.lines.some((l) => l.startsWith("updated hearth")));
});

test("token rotation is transparent; a run longer than the token lifetime completes", async (t) => {
  // Token dies in 90s; four agents at 61s pacing take ~183s of virtual time.
  const r = rig({ tokenTtlMs: 90_000, rotateMarginMs: 30_000 });
  t.after(() => rmSync(r.dir, { recursive: true, force: true }));
  await r.provisioner.run({
    manifests: manifests(["a", "one"], ["b", "two"], ["c", "three"], ["d", "four"]),
    warnings: [],
    dryRun: false,
  });
  assert.equal(r.api.creates, 4, "run completed past token expiry");
  assert.ok(r.api.rotations >= 1, "rotated at least once");
  const persisted = r.store.read<ConfigTokenPair>(CONFIG_TOKEN_FILE);
  assert.equal(persisted?.token, TOKEN_B, "rotated pair persisted");
  assert.equal(persisted?.refreshToken, REFRESH_B);
  const mode = statSync(r.store.path(CONFIG_TOKEN_FILE)).mode & 0o777;
  assert.equal(mode, 0o600, "token file is 0600");
});

test("provisioning four agents paces for the Tier 1 rate limit", async (t) => {
  const r = rig();
  t.after(() => rmSync(r.dir, { recursive: true, force: true }));
  // FakeSlackAdmin throws 'ratelimited' if mutations come <60s apart.
  await r.provisioner.run({
    manifests: manifests(["a", "one"], ["b", "two"], ["c", "three"], ["d", "four"]),
    warnings: [],
    dryRun: false,
  });
  assert.equal(r.api.creates, 4, "all four created without ratelimited");
  assert.equal(r.sleeps.length, 3, "paced between consecutive mutations");
  assert.ok(r.sleeps.every((ms) => ms > 0 && ms <= 61_000));
});

test("no token value appears in any report line; state records app ids", async (t) => {
  const r = rig({ tokenTtlMs: 90_000, rotateMarginMs: 30_000 });
  t.after(() => rmSync(r.dir, { recursive: true, force: true }));
  await r.provisioner.run({
    manifests: manifests(["a", "one"], ["b", "two"], ["c", "three"], ["d", "four"]),
    warnings: ["agent a: upload the icon by hand"],
    dryRun: false,
  });
  for (const line of r.lines) {
    for (const secret of [TOKEN_A, TOKEN_B, REFRESH_A, REFRESH_B]) {
      assert.ok(!line.includes(secret), `token leaked into output: ${line}`);
    }
  }
  assert.ok(r.lines.some((l) => l.includes("manual step") && l.includes("icon")));
  assert.ok(r.lines.some((l) => l.includes("install a: https://slack.com/oauth/authorize")));
  const state = r.store.read<{ apps: Record<string, { appId: string }> }>(PROVISION_STATE_FILE);
  assert.equal(Object.keys(state?.apps ?? {}).length, 4);
});

test("diffPaths names nested changes precisely", () => {
  assert.deepEqual(diffPaths({ a: { b: 1, c: 2 } }, { a: { b: 1, c: 3 } }), ["a.c"]);
  assert.deepEqual(diffPaths({ a: 1 }, { a: 1 }), []);
  assert.deepEqual(diffPaths({ a: [1, 2] }, { a: [1, 3] }), ["a.1"]);
});
