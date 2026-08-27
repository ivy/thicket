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
      "       thicket doctor\n" +
      "       thicket fleet\n" +
      "       thicket mcp\n" +
      "       thicket slack-test-mcp   (development: drives Slack as you)\n",
  );
  process.exit(2);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);

  // Read lazily: the Slack test harness talks only to Slack, and failing
  // for want of a fleet roster it never consults would be a poor error.
  let cachedYaml: string | undefined;
  const loadYaml = (): string => {
    cachedYaml ??= readFileSync(
      process.env.THICKET_AGENTS_FILE ?? join(configDir(), "agents.yaml"),
      "utf8",
    );
    return cachedYaml;
  };
  const loadRoster = () => parseRoster(loadYaml());

  if (command === "provision") {
    const dryRun = rest.includes("--dry-run");
    const agentFlag = rest.indexOf("--agent");
    const only = agentFlag !== -1 ? rest[agentFlag + 1] : undefined;

    // Opt-in, deliberately not a config field: an app that requests user
    // scopes mints a token acting as the operator, and that should be a
    // conscious act at a terminal rather than a line someone inherits.
    const testHarness = process.env.THICKET_SLACK_TEST_HARNESS === "1";

    const manifests = new Map<string, SlackManifest>();
    const warnings: string[] = [];
    const roster = loadRoster();
    for (const [name, entry] of Object.entries(roster.agents)) {
      const rendered = toSlackManifest(toAgentCard(name, entry), { testHarness });
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
      const written = renderAccountConfigs(roster, loadYaml(), {
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

  if (command === "fleet") {
    const { fleetHealth, formatFleet } = await import("./fleet.js");
    const { egressHttp } = await import("./mcp/http.js");
    const { socketPath } = await import("@thicket/roster");
    const results = await fleetHealth(loadRoster(), {
      http: egressHttp(process.env.THICKET_EGRESS_SOCKET ?? socketPath("netd-egress")),
      tailnetDomain: process.env.THICKET_TAILNET_DOMAIN,
      endpointOverrides:
        process.env.THICKET_MCP_ENDPOINTS !== undefined
          ? (JSON.parse(process.env.THICKET_MCP_ENDPOINTS) as Record<string, string>)
          : undefined,
    });
    for (const line of formatFleet(results)) {
      process.stdout.write(line + "\n");
    }
    process.exit(results.every((r) => r.up) ? 0 : 1);
  }

  if (command === "mcp") {
    const { StdioServerTransport } = await import(
      "@modelcontextprotocol/sdk/server/stdio.js"
    );
    const { buildMcpServer } = await import("./mcp/server.js");
    const { egressHttp } = await import("./mcp/http.js");
    const { socketPath } = await import("@thicket/roster");
    const egressSocket = process.env.THICKET_EGRESS_SOCKET ?? socketPath("netd-egress");
    const server = buildMcpServer({
      roster: loadRoster(),
      http: egressHttp(egressSocket),
      tailnetDomain: process.env.THICKET_TAILNET_DOMAIN,
      endpointOverrides:
        process.env.THICKET_MCP_ENDPOINTS !== undefined
          ? (JSON.parse(process.env.THICKET_MCP_ENDPOINTS) as Record<string, string>)
          : undefined,
    });
    await server.connect(new StdioServerTransport());
    return; // serves until stdio closes
  }

  if (command === "slack-test-mcp") {
    const { StdioServerTransport } = await import(
      "@modelcontextprotocol/sdk/server/stdio.js"
    );
    const { buildSlackTestServer } = await import("./slack-test/server.js");
    const { SlackTestClient } = await import("./slack-test/client.js");
    const store = new FileStore(configDir());
    const creds = store.read<{ user_token?: string }>("slack-test-harness.json");
    const token = process.env.THICKET_SLACK_USER_TOKEN ?? creds?.user_token;
    if (token === undefined || token === "") {
      process.stderr.write(
        "no user token: write {\"user_token\": \"xoxp-…\"} to " +
          `${store.path("slack-test-harness.json")} (mode 0600), ` +
          "or set THICKET_SLACK_USER_TOKEN.\n",
      );
      process.exit(2);
    }
    const server = buildSlackTestServer({ client: new SlackTestClient({ token }) });
    await server.connect(new StdioServerTransport());
    return; // serves until stdio closes
  }

  if (command === "doctor") {
    // Probes run real commands/network; wired here, logic lives in doctor.ts.
    const { realProbes } = await import("./doctor-probes.js");
    const results = await runDoctor(loadRoster(), realProbes());
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
