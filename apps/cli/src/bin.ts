#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { configDir, parseRoster, toAgentCard, type Roster } from "@thicket/roster";
import { toSlackManifest, type SlackManifest } from "@thicket/slack-manifest";

import { doctorExitCode, formatResults, runDoctor } from "./doctor.js";
import { HttpTwilioNumberApi, provisionNumber, readTwilioProvisioning } from "./phone-provision.js";
import { Provisioner } from "./provision.js";
import { renderAccountConfigs } from "./render-config.js";
import { HttpSlackAdminApi } from "./slack-admin.js";
import { FileStore } from "./store.js";

function usage(): never {
  process.stderr.write(
    "usage: thicket provision [--dry-run] [--agent NAME]\n" +
      "       thicket render [--out DIR]\n" +
      "       thicket doctor\n" +
      "       thicket fleet\n" +
      "       thicket journal [--cost] [--failures] [--trigger T] [--days N] [--limit N] [--db PATH]\n" +
      "       thicket mcp\n" +
      "       thicket slack-test-mcp   (development: drives Slack as you)\n" +
      "       thicket phone-test-mcp   (development: drives the phone bridge as the operator)\n" +
      "       thicket phone-test run <scenario|all> | list | redact <recording>…\n",
  );
  process.exit(2);
}

/** Where a rendered tree lands unless a caller says otherwise. */
function defaultRenderDir(): string {
  return join(configDir(), "rendered");
}

/**
 * The one render path. `provision` and `render` share it so the tree cannot
 * differ by which command produced it — the inputs are the roster, the tags
 * every agent admits, and the tailnet domain, and nothing else.
 */
function renderInto(roster: Roster, rosterYaml: string, outDir: string): void {
  const written = renderAccountConfigs(roster, rosterYaml, {
    outDir,
    allowedPeerTags: [
      "tag:thicket-bridge",
      ...Object.values(roster.agents).map((entry) => entry.tag),
    ],
    tailnetDomain: process.env.THICKET_TAILNET_DOMAIN,
  });
  process.stdout.write(`rendered ${written.length} per-account config files into ${outDir}\n`);
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

    const store = new FileStore(configDir());
    const report = (line: string) => process.stdout.write(line + "\n");
    const provisioner = new Provisioner({
      api: new HttpSlackAdminApi(),
      store,
      report,
    });
    await provisioner.run({ manifests, warnings, dryRun, only });

    // The number, when the operator has given us one: pointed at the bridge
    // the same way, after saying what would change.
    const twilio = readTwilioProvisioning(store);
    if (twilio === undefined) {
      report(`phone number: no ${store.path("twilio.json")} — nothing to point at a bridge`);
    } else if (only === undefined) {
      await provisionNumber(
        { number: twilio.number, publicBaseUrl: twilio.public_base_url, dryRun },
        { api: new HttpTwilioNumberApi(twilio), report },
      );
    }

    if (!dryRun) {
      renderInto(roster, loadYaml(), defaultRenderDir());
    }
    return;
  }

  // Rendering and provisioning have opposite cadences: Slack apps are
  // created rarely and by hand, per-account config is regenerated whenever
  // anything it derives from moves. A deployer needs the second without
  // ever risking the first.
  if (command === "render") {
    const outFlag = rest.indexOf("--out");
    const outDir = outFlag !== -1 ? rest[outFlag + 1] : undefined;
    if (outFlag !== -1 && outDir === undefined) {
      process.stderr.write("render: --out needs a directory\n");
      process.exit(2);
    }
    renderInto(loadRoster(), loadYaml(), outDir ?? defaultRenderDir());
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

  if (command === "phone-test-mcp") {
    const { StdioServerTransport } = await import(
      "@modelcontextprotocol/sdk/server/stdio.js"
    );
    const { loadPhoneTestConfig, PhoneTestConfigError } = await import("./phone-test/config.js");
    const { CallerLeg } = await import("./phone-test/leg.js");
    const { HttpTwilioRest } = await import("./phone-test/caller.js");
    const { buildPhoneTestServer } = await import("./phone-test/server.js");
    const { stateDir } = await import("@thicket/roster");
    let config: import("./phone-test/config.js").PhoneTestConfig;
    try {
      config = loadPhoneTestConfig(
        process.env.THICKET_PHONE_TEST_CONFIG ?? join(configDir(), "phone-test.json"),
      );
    } catch (err) {
      process.stderr.write((err instanceof PhoneTestConfigError ? err.message : String(err)) + "\n");
      process.exit(2);
    }
    // stdout is the MCP transport; every line of the leg's goes to stderr.
    const write = (level: string, msg: string, fields?: Record<string, unknown>) => {
      process.stderr.write(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields }) + "\n");
    };
    const leg = new CallerLeg({
      publicBaseUrl: config.public_base_url,
      pathPrefix: config.path_prefix,
      authToken: config.twilio.auth_token,
      pin: config.pin,
      rest: new HttpTwilioRest({
        accountSid: config.twilio.account_sid,
        authToken: config.twilio.auth_token,
        ...(config.twilio.api_key_sid === undefined ? {} : { apiKeySid: config.twilio.api_key_sid }),
        ...(config.twilio.api_key_secret === undefined ? {} : { apiKeySecret: config.twilio.api_key_secret }),
        to: config.number,
        ...(config.from === undefined ? {} : { from: config.from }),
      }),
      recordingsDir: config.recordings_dir ?? join(stateDir(), "phone-test", "recordings"),
      logger: {
        info: (msg, fields) => write("info", msg, fields),
        warn: (msg, fields) => write("warn", msg, fields),
      },
    });
    const httpServer = leg.createServer();
    const [hostname, port] = config.listen.split(":");
    await new Promise<void>((resolve) => httpServer.listen(Number(port), hostname, () => resolve()));
    write("info", "caller leg listening", { listen: config.listen });
    const server = buildPhoneTestServer({ leg });
    await server.connect(new StdioServerTransport());
    return; // serves until stdio closes
  }

  if (command === "phone-test") {
    if (rest[0] === "redact") {
      if (rest.length < 2) {
        usage();
      }
      const { redactFiles } = await import("./phone-test/redact.js");
      process.stdout.write(redactFiles(rest.slice(1)).join("\n") + "\n");
      return;
    }
    const { loadPhoneTestConfig, PhoneTestConfigError } = await import("./phone-test/config.js");
    const { runPhoneTest } = await import("./phone-test/runner.js");
    let config: import("./phone-test/config.js").PhoneTestConfig;
    try {
      config = loadPhoneTestConfig(
        process.env.THICKET_PHONE_TEST_CONFIG ?? join(configDir(), "phone-test.json"),
      );
    } catch (err) {
      process.stderr.write((err instanceof PhoneTestConfigError ? err.message : String(err)) + "\n");
      process.exit(2);
    }
    const write = (level: string, msg: string, fields?: Record<string, unknown>) => {
      process.stderr.write(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields }) + "\n");
    };
    process.exit(
      await runPhoneTest(rest, config, {
        out: (line) => process.stdout.write(line + "\n"),
        logger: {
          info: (msg, fields) => write("info", msg, fields),
          warn: (msg, fields) => write("warn", msg, fields),
        },
      }),
    );
  }

  if (command === "journal") {
    const { parseJournalArgs, runJournal } = await import("./journal.js");
    const parsed = parseJournalArgs(rest);
    if (parsed === undefined) {
      usage();
    }
    const { lines, exitCode } = runJournal(parsed.query, parsed.db);
    for (const line of lines) {
      process.stdout.write(line + "\n");
    }
    process.exit(exitCode);
  }

  if (command === "doctor") {
    // Probes run real commands/network; wired here, logic lives in doctor.ts.
    const { realProbes } = await import("./doctor-probes.js");
    const roster = loadRoster();
    const results = await runDoctor(
      roster,
      realProbes({
        roster,
        store: new FileStore(configDir()),
        tailnetDomain: process.env.THICKET_TAILNET_DOMAIN,
        // Same dev-rig override fleet and mcp honour: agents reachable on
        // local ports where there is no tailnet.
        endpointOverrides:
          process.env.THICKET_MCP_ENDPOINTS !== undefined
            ? (JSON.parse(process.env.THICKET_MCP_ENDPOINTS) as Record<string, string>)
            : undefined,
      }),
    );
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
