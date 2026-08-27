#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { configDir, parseRoster, toAgentCard } from "@thicket/roster";
import { toSlackManifest, type SlackManifest } from "@thicket/slack-manifest";

import { doctorExitCode, formatResults, runDoctor } from "./doctor.js";
import { Provisioner } from "./provision.js";
import { renderAccountConfigs } from "./render-config.js";
import { HttpSlackAdminApi } from "./slack-admin.js";
import { FileStore } from "./store.js";

function usage(): never {
  process.stderr.write(
    "usage: thicket provision [--dry-run] [--agent NAME]\n" +
      "       thicket doctor\n",
  );
  process.exit(2);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const rosterPath = process.env.THICKET_AGENTS_FILE ?? join(configDir(), "agents.yaml");
  const rosterYaml = readFileSync(rosterPath, "utf8");
  const roster = parseRoster(rosterYaml);

  if (command === "provision") {
    const dryRun = rest.includes("--dry-run");
    const agentFlag = rest.indexOf("--agent");
    const only = agentFlag !== -1 ? rest[agentFlag + 1] : undefined;

    const manifests = new Map<string, SlackManifest>();
    const warnings: string[] = [];
    for (const [name, entry] of Object.entries(roster.agents)) {
      const rendered = toSlackManifest(toAgentCard(name, entry));
      manifests.set(name, rendered.manifest);
      warnings.push(...rendered.warnings);
    }

    const provisioner = new Provisioner({
      api: new HttpSlackAdminApi(),
      store: new FileStore(configDir()),
      report: (line) => process.stdout.write(line + "\n"),
    });
    await provisioner.run({ manifests, warnings, dryRun, only });

    if (!dryRun) {
      const written = renderAccountConfigs(roster, rosterYaml, {
        outDir: join(configDir(), "rendered"),
        allowedPeerTags: [
          "tag:thicket-bridge",
          ...Object.values(roster.agents).map((entry) => entry.tag),
        ],
        tailnetDomain: process.env.THICKET_TAILNET_DOMAIN,
      });
      process.stdout.write(`rendered ${written.length} per-account config files\n`);
    }
    return;
  }

  if (command === "doctor") {
    // Probes run real commands/network; wired here, logic lives in doctor.ts.
    const { realProbes } = await import("./doctor-probes.js");
    const results = await runDoctor(roster, realProbes());
    for (const line of formatResults(results)) {
      process.stdout.write(line + "\n");
    }
    process.exit(doctorExitCode(results));
  }

  usage();
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
