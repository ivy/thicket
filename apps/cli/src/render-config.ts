import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { nodeName, phoneEnabledAgents, type Roster } from "@thicket/roster";

/** The phone bridge's account: its tag, and the tailnet node netd names. */
export const PHONE_TAG = "tag:thicket-phone";
export const PHONE_HOSTNAME = "thicket-phone";

/** The bridge's tailnet node: the fleet's Slack surface, and its file surface. */
export const BRIDGE_HOSTNAME = "thicket-bridge";

/**
 * The name a tailnet node is dialed by — fully qualified once the domain is
 * known, the bare MagicDNS name until then. The same two shapes `agentUrl`
 * produces, because an egress rule has to match the name that will be asked
 * for.
 */
function tailnetName(node: string, tailnetDomain?: string): string {
  return tailnetDomain === undefined ? node : `${node}.${tailnetDomain}`;
}

export interface RenderConfigOptions {
  /** Output root; one directory per agent is created inside. */
  outDir: string;
  tailnetDomain?: string;
  /** Peer tags allowed to call every agent (the bridge's tag, plus peers). */
  allowedPeerTags: string[];
}

/**
 * Renders each agent's per-account configuration tree. Deploy tooling
 * (task 012) copies `<outDir>/<agent>/` into that account's
 * ~/.config/thicket/. Reproducible from agents.yaml by construction:
 * hand-editing the output is a bug in this renderer.
 */
export function renderAccountConfigs(
  roster: Roster,
  rosterYaml: string,
  options: RenderConfigOptions,
): string[] {
  const written: string[] = [];
  const onThePhone = new Set(phoneEnabledAgents(roster).map((a) => a.name));
  // netd reaches nothing it was not told to reach. An agent account talks to
  // the bridge — the Slack toolbelt, and the file surface attachments are
  // fetched from — and to the rest of the fleet, because the CLI dials agents
  // from whichever account runs it. That is the edge the tailnet ACL already
  // draws; what the allowlist adds is that nothing off the tailnet is
  // reachable at all.
  const fleet = [
    tailnetName(BRIDGE_HOSTNAME, options.tailnetDomain),
    ...Object.values(roster.agents).map((entry) => tailnetName(nodeName(entry), options.tailnetDomain)),
  ];
  for (const [agent, entry] of Object.entries(roster.agents)) {
    const dir = join(options.outDir, agent);
    mkdirSync(dir, { recursive: true });

    writeFileSync(join(dir, "agents.yaml"), rosterYaml);
    written.push(join(dir, "agents.yaml"));

    const agentd = {
      agent,
      agents_file: "agents.yaml",
      // The phone bridge's tag may call an agent only when its roster entry
      // opts in: that line is where a privileged agent gets onto the phone.
      allowed_peer_tags: onThePhone.has(agent) ? [...options.allowedPeerTags, PHONE_TAG] : options.allowedPeerTags,
      ...(options.tailnetDomain !== undefined ? { tailnet_domain: options.tailnetDomain } : {}),
      // The bridge's inbound netd, named per deploy/README.md; gives the
      // session its Slack toolbelt. Development rigs override by hand.
      ...(options.tailnetDomain !== undefined
        ? { bridge_base_url: `https://${tailnetName(BRIDGE_HOSTNAME, options.tailnetDomain)}` }
        : {}),
    };
    writeFileSync(join(dir, "agentd.json"), JSON.stringify(agentd, null, 2) + "\n");
    written.push(join(dir, "agentd.json"));

    const netd = {
      hostname: nodeName(entry),
      tag: entry.tag,
      auth_key_file: "tailnet-auth-key",
      egress_allow: fleet,
    };
    writeFileSync(join(dir, "netd.json"), JSON.stringify(netd, null, 2) + "\n");
    written.push(join(dir, "netd.json"));
  }

  // The phone account exists once any agent answers the phone. Its
  // roster-derived half is the roster itself (the bridge reads
  // phone.enabled and the spoken names from it) and a netd that faces the
  // internet; the secrets half — numbers, PIN, tokens — is the operator's
  // 0600 phone.json and is never rendered.
  if (onThePhone.size > 0) {
    const dir = join(options.outDir, "phone");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "agents.yaml"), rosterYaml);
    written.push(join(dir, "agents.yaml"));
    const netd = {
      hostname: PHONE_HOSTNAME,
      tag: PHONE_TAG,
      auth_key_file: "tailnet-auth-key",
      // Only the agents that answer the phone: the account exists to put a
      // caller in front of one of them and nothing else.
      egress_allow: Object.entries(roster.agents)
        .filter(([agent]) => onThePhone.has(agent))
        .map(([, entry]) => tailnetName(nodeName(entry), options.tailnetDomain)),
      funnel: { path_prefix: "/" },
    };
    writeFileSync(join(dir, "netd.json"), JSON.stringify(netd, null, 2) + "\n");
    written.push(join(dir, "netd.json"));
  }
  return written;
}
