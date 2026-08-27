import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Roster } from "@thicket/roster";

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
  for (const [agent, entry] of Object.entries(roster.agents)) {
    const dir = join(options.outDir, agent);
    mkdirSync(dir, { recursive: true });

    writeFileSync(join(dir, "agents.yaml"), rosterYaml);
    written.push(join(dir, "agents.yaml"));

    const agentd = {
      agent,
      agents_file: "agents.yaml",
      allowed_peer_tags: options.allowedPeerTags,
      ...(options.tailnetDomain !== undefined ? { tailnet_domain: options.tailnetDomain } : {}),
    };
    writeFileSync(join(dir, "agentd.json"), JSON.stringify(agentd, null, 2) + "\n");
    written.push(join(dir, "agentd.json"));

    const netd = {
      hostname: entry.tag.slice("tag:".length),
      tag: entry.tag,
      auth_key_file: "tailnet-auth-key",
    };
    writeFileSync(join(dir, "netd.json"), JSON.stringify(netd, null, 2) + "\n");
    written.push(join(dir, "netd.json"));
  }
  return written;
}
