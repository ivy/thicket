import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseRoster } from "@thicket/roster";

import { BRIDGE_HOSTNAME, PHONE_TAG, renderAccountConfigs } from "./render-config.js";

const YAML = `
agents:
  hearth:
    host: home
    user: hearth
    description: Personal assistant agent.
    tag: tag:thicket-hearth
    harness: { type: claude-agent-sdk, cwd: /home/hearth, model: claude-opus-5 }
    phone: { enabled: true, spokenName: Hearth }
  forge:
    host: workshop
    user: forge
    description: CI fixer agent.
    tag: tag:thicket-forge
    harness: { type: claude-agent-sdk, cwd: /home/forge, model: claude-sonnet-5 }
`;

test("a phone-enabled roster renders the phone account and lets its tag call only the agents that opted in", (t) => {
  const out = mkdtempSync(join(tmpdir(), "render-"));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  const written = renderAccountConfigs(parseRoster(YAML), YAML, { outDir: out, allowedPeerTags: ["tag:thicket-bridge"] });

  const hearth = JSON.parse(readFileSync(join(out, "hearth", "agentd.json"), "utf8")) as { allowed_peer_tags: string[] };
  const forge = JSON.parse(readFileSync(join(out, "forge", "agentd.json"), "utf8")) as { allowed_peer_tags: string[] };
  assert.deepEqual(hearth.allowed_peer_tags, ["tag:thicket-bridge", PHONE_TAG]);
  assert.deepEqual(forge.allowed_peer_tags, ["tag:thicket-bridge"], "forge is not on the phone");

  const netd = JSON.parse(readFileSync(join(out, "phone", "netd.json"), "utf8")) as Record<string, unknown>;
  assert.deepEqual(netd, {
    hostname: "thicket-phone",
    tag: PHONE_TAG,
    auth_key_file: "tailnet-auth-key",
    egress_allow: ["thicket-hearth"],
    funnel: { path_prefix: "/" },
  });
  assert.equal(readFileSync(join(out, "phone", "agents.yaml"), "utf8"), YAML);
  assert.ok(!existsSync(join(out, "phone", "phone.json")), "the secrets half is never rendered");
  assert.ok(written.includes(join(out, "phone", "netd.json")));
});

test("without a phone-enabled agent there is no phone account", (t) => {
  const out = mkdtempSync(join(tmpdir(), "render-"));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  const yaml = YAML.replace("    phone: { enabled: true, spokenName: Hearth }\n", "");
  renderAccountConfigs(parseRoster(yaml), yaml, { outDir: out, allowedPeerTags: ["tag:thicket-bridge"] });
  assert.ok(!existsSync(join(out, "phone")));
});

test("every account's netd is told what it may reach, and nothing else", (t) => {
  const out = mkdtempSync(join(tmpdir(), "render-"));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  renderAccountConfigs(parseRoster(YAML), YAML, {
    outDir: out,
    allowedPeerTags: ["tag:thicket-bridge"],
    tailnetDomain: "tail42.ts.net",
  });

  const netd = (agent: string) =>
    JSON.parse(readFileSync(join(out, agent, "netd.json"), "utf8")) as { egress_allow: string[] };

  // The bridge and the fleet, fully qualified: the names these accounts will
  // actually ask netd for.
  const fleet = [
    `${BRIDGE_HOSTNAME}.tail42.ts.net`,
    "thicket-hearth.tail42.ts.net",
    "thicket-forge.tail42.ts.net",
  ];
  assert.deepEqual(netd("hearth").egress_allow, fleet);
  assert.deepEqual(netd("forge").egress_allow, fleet);
  // The phone account reaches only the agents that answer the phone.
  assert.deepEqual(netd("phone").egress_allow, ["thicket-hearth.tail42.ts.net"]);
});

test("without a tailnet domain the allowlist carries the bare MagicDNS names", (t) => {
  const out = mkdtempSync(join(tmpdir(), "render-"));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  renderAccountConfigs(parseRoster(YAML), YAML, { outDir: out, allowedPeerTags: ["tag:thicket-bridge"] });
  const netd = JSON.parse(readFileSync(join(out, "hearth", "netd.json"), "utf8")) as {
    egress_allow: string[];
  };
  assert.deepEqual(netd.egress_allow, [BRIDGE_HOSTNAME, "thicket-hearth", "thicket-forge"]);
});
