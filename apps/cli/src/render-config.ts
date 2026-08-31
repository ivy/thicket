import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { nodeName, phoneEnabledAgents, type Roster } from "@thicket/roster";

/** The phone bridge's account: its tag, and the tailnet node netd names. */
export const PHONE_TAG = "tag:thicket-phone";
export const PHONE_HOSTNAME = "thicket-phone";

/** The bridge's tailnet node: the fleet's Slack surface, and its file surface. */
export const BRIDGE_HOSTNAME = "thicket-bridge";
export const BRIDGE_TAG = "tag:thicket-bridge";

/**
 * Where the Slack Web API answers. The phone bridge posts its security
 * alerts there — an unknown caller, a failed PIN, a lockout — and this rule
 * is unconditional because nothing here can see whether they are configured:
 * the channel and the token live in the operator's own `phone.json`, which
 * holds the PIN and is never rendered. An allowance nobody uses costs
 * nothing; the other choice costs the alert at the moment it was worth
 * having. The API host alone — the phone redeems no files, so it needs
 * none of the hosts Slack hands out at run time.
 */
export const SLACK_API_HOST = "slack.com";

/**
 * The hosts Slack hands out at run time — files, and the websocket a Socket
 * Mode connection is opened to. A wildcard rather than today's names, which
 * are Slack's to change; and beside `SLACK_API_HOST` rather than instead of
 * it, because `*.slack.com` deliberately does not admit `slack.com`.
 */
export const SLACK_RUNTIME_HOSTS = "*.slack.com";

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

  // The Slack bridge's account. Nothing in it is a judgement call: its node
  // and tag are fixed, and what it may reach is the whole fleet plus Slack.
  // The fleet half is the reason this is rendered at all — it moves every
  // time the roster does, and an allowlist that drifts from the roster fails
  // closed and quietly, leaving a newly added agent unreachable for a reason
  // that lives in a file nobody re-reads.
  {
    const dir = join(options.outDir, "bridge");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "agents.yaml"), rosterYaml);
    written.push(join(dir, "agents.yaml"));
    const netd = {
      hostname: BRIDGE_HOSTNAME,
      tag: BRIDGE_TAG,
      auth_key_file: "tailnet-auth-key",
      // The bridge's own socket, not an agentd's: this account runs no agent,
      // and what a tailnet peer comes here for is the bytes of a file the
      // bridge holds. A name rather than a path, so one rendered file is
      // right whether the account runs as a user unit or a system one.
      upstream_socket: "bridge",
      egress_allow: [
        ...Object.values(roster.agents).map((entry) => tailnetName(nodeName(entry), options.tailnetDomain)),
        SLACK_API_HOST,
        SLACK_RUNTIME_HOSTS,
      ],
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
      // The agents that answer the phone — the account exists to put a caller
      // in front of one of them — and Slack, which is where it says so when
      // something goes wrong.
      egress_allow: [
        ...Object.entries(roster.agents)
          .filter(([agent]) => onThePhone.has(agent))
          .map(([, entry]) => tailnetName(nodeName(entry), options.tailnetDomain)),
        SLACK_API_HOST,
      ],
      funnel: { path_prefix: "/" },
    };
    writeFileSync(join(dir, "netd.json"), JSON.stringify(netd, null, 2) + "\n");
    written.push(join(dir, "netd.json"));
  }
  return written;
}
