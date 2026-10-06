import test from "node:test";
import assert from "node:assert/strict";

import { parseRoster } from "@thicket/roster";

import { doctorExitCode, formatResults, runDoctor, type DoctorProbes } from "./doctor.js";

const ROSTER = parseRoster(`
agents:
  hearth:
    host: home
    user: hearth
    description: Personal assistant agent.
    tag: tag:thicket-hearth
    reach:
      operators: anyone
    harness: { type: claude-agent-sdk, cwd: /home/hearth, model: claude-opus-5 }
  forge:
    host: workshop
    user: forge
    description: CI fixer agent.
    tag: tag:thicket-forge
    reach:
      operators: anyone
    harness: { type: claude-agent-sdk, cwd: /home/forge, model: claude-sonnet-5 }
`);

function healthyProbes(): DoctorProbes {
  return {
    fetchCard: async (agent) => ({ name: agent }),
    tailnetNodes: async () => ({
      nodes: [
        { hostname: "thicket-hearth", tags: ["tag:thicket-hearth"] },
        { hostname: "thicket-forge", tags: ["tag:thicket-forge"] },
      ],
      // A member device: it sees the whole tailnet, so an absent node is
      // absent rather than merely out of view.
      selfTags: [],
      selfHostname: "laptop",
    }),
    installedVersions: async () => [
      { name: "thicket", version: "1.2.3", path: "/usr/local/bin/thicket" },
    ],
    slackApp: async () => ({ installed: true, socketMode: true }),
    workspaceAppUsage: async () => ({ installed: 4, cap: 10 }),
    startsAtBoot: async () => ({ enabled: true, mechanism: "loginctl lingering" }),
    phoneNumber: async () => ({ number: "+15550100002", drift: [] }),
    phoneConfig: async () => ({ ok: true, source: "/etc/thicket (system unit)" }),
    phonePublic: async () => ({ url: "https://thicket-phone.tail0000.ts.net/", status: 404 }),
    phoneHealth: async () => ({ ts: new Date().toISOString(), openCalls: 0 }),
    bridgeHealth: async () => ({
      ts: new Date().toISOString(),
      agents: [
        { agent: "hearth", connected: true, attempts: 0 },
        { agent: "forge", connected: true, attempts: 0 },
      ],
    }),
  };
}

test("all checks pass: exit code 0", async () => {
  const results = await runDoctor(ROSTER, healthyProbes());
  assert.equal(doctorExitCode(results), 0);
  assert.ok(results.every((r) => r.ok));
});

test("missing tailnet tag is detected with a distinct message", async () => {
  const probes = healthyProbes();
  probes.tailnetNodes = async () => ({
    nodes: [
    { hostname: "thicket-hearth", tags: [] },
    { hostname: "thicket-forge", tags: ["tag:thicket-forge"] },
  ],
    selfTags: [],
    selfHostname: "laptop",
  });
  const results = await runDoctor(ROSTER, probes);
  const failure = results.find((r) => !r.ok);
  assert.ok(failure);
  assert.equal(failure.check, "tailnet");
  assert.equal(failure.agent, "hearth");
  assert.match(failure.message, /missing tag tag:thicket-hearth/);
  assert.equal(doctorExitCode(results), 1);
});

test("a node absent from the tailnet is reported differently from a missing tag", async () => {
  const probes = healthyProbes();
  probes.tailnetNodes = async () => ({
    nodes: [
    { hostname: "thicket-forge", tags: ["tag:thicket-forge"] },
  ],
    selfTags: [],
    selfHostname: "laptop",
  });
  const results = await runDoctor(ROSTER, probes);
  const failure = results.find((r) => !r.ok);
  assert.ok(failure);
  assert.match(failure.message, /no tailnet node named thicket-hearth/);
});

test("uninstalled Slack app is detected", async () => {
  const probes = healthyProbes();
  probes.slackApp = async (agent) =>
    agent === "forge" ? { installed: false, socketMode: true } : { installed: true, socketMode: true };
  const results = await runDoctor(ROSTER, probes);
  const failure = results.find((r) => !r.ok);
  assert.ok(failure);
  assert.equal(failure.check, "slack");
  assert.equal(failure.agent, "forge");
  assert.match(failure.message, /not installed/);
});

test("stale card is detected and distinct from an unreachable card", async () => {
  const probes = healthyProbes();
  probes.fetchCard = async (agent) =>
    agent === "hearth" ? { name: "old-name" } : { name: agent };
  const stale = (await runDoctor(ROSTER, probes)).find((r) => !r.ok);
  assert.ok(stale);
  assert.equal(stale.check, "card");
  assert.match(stale.message, /stale/);

  probes.fetchCard = async (agent) => {
    if (agent === "hearth") {
      throw new Error("ECONNREFUSED");
    }
    return { name: agent };
  };
  const unreachable = (await runDoctor(ROSTER, probes)).find((r) => !r.ok);
  assert.ok(unreachable);
  assert.match(unreachable.message, /not fetchable/);
});

test("account without lingering is detected with remediation", async () => {
  const probes = healthyProbes();
  probes.startsAtBoot = async (_agent: string, user: string) => ({
    enabled: user !== "forge",
    mechanism: "loginctl lingering",
  });
  const results = await runDoctor(ROSTER, probes);
  const failure = results.find((r) => !r.ok);
  assert.ok(failure);
  assert.equal(failure.check, "lingering");
  assert.match(failure.message, /enable-linger forge/);
});

test("workspace at the app cap is detected", async () => {
  const probes = healthyProbes();
  probes.workspaceAppUsage = async () => ({ installed: 10, cap: 10 });
  const results = await runDoctor(ROSTER, probes);
  const failure = results.find((r) => !r.ok);
  assert.ok(failure);
  assert.equal(failure.check, "workspace");
  assert.match(failure.message, /app cap \(10\/10/);
});

test("a disconnected Socket Mode connection is reported unhealthy, not merely present", async () => {
  const probes = healthyProbes();
  probes.bridgeHealth = async () => ({
    ts: new Date().toISOString(),
    agents: [
      { agent: "hearth", connected: true, attempts: 0 },
      { agent: "forge", connected: false, attempts: 3 },
    ],
  });
  const results = await runDoctor(ROSTER, probes);
  const failure = results.find((r) => !r.ok);
  assert.ok(failure);
  assert.equal(failure.check, "bridge");
  assert.equal(failure.agent, "forge");
  assert.match(failure.message, /connection down \(3 reconnect attempts\)/);
});

test("a stale bridge heartbeat is a failure; an absent one is not", async () => {
  const probes = healthyProbes();
  probes.bridgeHealth = async () => ({
    ts: new Date(Date.now() - 5 * 60_000).toISOString(),
    agents: [{ agent: "hearth", connected: true, attempts: 0 }],
  });
  const stale = (await runDoctor(ROSTER, probes)).find((r) => !r.ok);
  assert.ok(stale);
  assert.equal(stale.check, "bridge");
  assert.match(stale.message, /stale/);

  probes.bridgeHealth = async () => undefined;
  const results = await runDoctor(ROSTER, probes);
  assert.equal(doctorExitCode(results), 0);
  const absent = results.find((r) => r.check === "bridge");
  assert.ok(absent);
  assert.ok(absent.ok);
  assert.match(absent.message, /no bridge health file/);
});

test("formatResults marks failures loudly and names the agent", async () => {
  const probes = healthyProbes();
  probes.startsAtBoot = async () => ({ enabled: false, mechanism: "loginctl lingering" });
  const lines = formatResults(await runDoctor(ROSTER, probes));
  assert.ok(lines.some((l) => l.startsWith("FAIL [lingering] hearth:")));
  assert.ok(lines.some((l) => l.startsWith("ok ")));
});

test("a throwing probe becomes a failed check and every other check still runs", async () => {
  const probes = healthyProbes();
  probes.tailnetNodes = async () => {
    throw new Error("spawn tailscale ENOENT");
  };
  probes.startsAtBoot = async () => {
    throw new Error("spawn loginctl ENOENT");
  };
  const results = await runDoctor(ROSTER, probes);

  const tailnet = results.filter((r) => r.check === "tailnet");
  assert.equal(tailnet.length, 1, "one probe-failure row, not one per agent");
  assert.equal(tailnet[0]!.ok, false);
  assert.match(tailnet[0]!.message, /cannot check: `tailscale` is not installed on this host/);

  const lingering = results.filter((r) => r.check === "lingering");
  assert.equal(lingering.length, 2, "still one row per agent");
  assert.ok(lingering.every((r) => !r.ok && /`loginctl` is not installed/.test(r.message)));

  for (const check of ["card", "slack", "bridge", "workspace"]) {
    assert.ok(
      results.some((r) => r.check === check),
      `${check} still ran`,
    );
  }
  assert.equal(doctorExitCode(results), 1);
});

test("a probe that throws something other than ENOENT reports the error itself", async () => {
  const probes = healthyProbes();
  probes.workspaceAppUsage = async () => {
    throw new Error("network is down");
  };
  const results = await runDoctor(ROSTER, probes);
  const workspace = results.find((r) => r.check === "workspace");
  assert.ok(workspace);
  assert.equal(workspace.ok, false);
  assert.match(workspace.message, /cannot check: network is down/);
  assert.ok(results.some((r) => r.check === "bridge" && r.ok), "later checks unaffected");
});

test("a number pointed elsewhere by hand is reported as drift; no twilio.json is not a failure", async () => {
  const drifted = await runDoctor(ROSTER, {
    ...healthyProbes(),
    phoneNumber: async () => ({ number: "+15550100002", drift: ["voiceUrl: https://old.example/twiml → https://thicket-phone.tail0000.ts.net/voice"] }),
  });
  const phone = drifted.find((r) => r.check === "phone");
  assert.equal(phone?.ok, false);
  assert.match(phone!.message, /not pointed at the bridge \(voiceUrl: https:\/\/old\.example\/twiml → .*\/voice\) — run thicket provision/);
  assert.equal(doctorExitCode(drifted), 1);

  const none = await runDoctor(ROSTER, { ...healthyProbes(), phoneNumber: async () => undefined });
  assert.equal(none.find((r) => r.check === "phone")?.ok, true);
  assert.equal(doctorExitCode(none), 0);
});

test("every link of the phone path is reported, and one broken link exits non-zero", async () => {
  const healthy = await runDoctor(ROSTER, healthyProbes());
  const phone = healthy.filter((r) => r.check === "phone");
  assert.equal(phone.length, 4, "config, public hostname, number, heartbeat");
  assert.ok(phone.every((r) => r.ok));
  assert.equal(doctorExitCode(healthy), 0);

  const cases: Array<[Partial<DoctorProbes>, RegExp]> = [
    [{ phoneConfig: async () => ({ ok: false, source: "/x (this account)", error: "phone config /x/phone.json is invalid:\n  pin: the PIN is exactly eight digits" }) }, /phone\.json will not load: [\s\S]*pin: the PIN is exactly eight digits/],
    [{ phonePublic: async () => { throw new Error("fetch failed"); } }, /public hostname not answering: .*fetch failed — is the phone account's netd up/],
    // A caller refused by its own allow-list has learned nothing about the
    // target, so the netd/Funnel hint must not appear beside it.
    [{ phonePublic: async () => { throw new Error("egress proxy refused CONNECT: HTTP/1.1 403 Forbidden"); } }, /public hostname not checked: .*egress allow-list/],
    [{ phonePublic: async () => ({ url: "https://x/", status: 502 }) }, /answered HTTP 502, not the bridge's 404 — netd is up but nothing is listening behind it: the phone bridge is down/],
    [{ phonePublic: async () => ({ url: "https://x/", status: 200 }) }, /answered HTTP 200, not the bridge's 404 — something else is in front/],
    [{ phoneHealth: async () => ({ ts: new Date(Date.now() - 120_000).toISOString(), openCalls: 1 }) }, /phone heartbeat is stale \(last 120s ago\).*a restart drops live calls/],
  ];
  for (const [broken, expected] of cases) {
    const results = await runDoctor(ROSTER, { ...healthyProbes(), ...broken });
    const failed = results.filter((r) => r.check === "phone" && !r.ok);
    assert.equal(failed.length, 1, expected.source);
    assert.match(failed[0]!.message, expected);
    assert.equal(doctorExitCode(results), 1);
  }

  // A host without the phone bridge: nothing to check is not a failure.
  const elsewhere = await runDoctor(ROSTER, { ...healthyProbes(), phoneConfig: async () => undefined, phonePublic: async () => undefined, phoneHealth: async () => undefined, phoneNumber: async () => undefined });
  assert.ok(elsewhere.filter((r) => r.check === "phone").every((r) => r.ok));
});

// The fleet's processes speak to each other, so they have to move together.
// Half an upgrade is the failure this catches, and a path cannot see it: a
// symlink says where a binary came from, not what is in it.
test("binaries from different releases are a failure, not a note", async () => {
  const probes = healthyProbes();
  probes.installedVersions = async () => [
    { name: "thicket", version: "0.2.0", path: "/usr/local/bin/thicket" },
    { name: "thicket-agentd", version: "0.1.0", path: "/usr/local/bin/thicket-agentd" },
  ];
  const results = await runDoctor(ROSTER, probes);
  const failure = results.find((r) => r.check === "version" && !r.ok);
  assert.ok(failure, "a split installation passed");
  assert.match(failure.message, /disagree/);
});

test("no thicket executables on PATH is reported rather than passed over", async () => {
  const probes = healthyProbes();
  probes.installedVersions = async () => [];
  const results = await runDoctor(ROSTER, probes);
  assert.ok(results.some((r) => r.check === "version" && !r.ok));
});

test("a phone config only root can read is the file being right, not missing", async () => {
  // A system-unit deployment keeps phone.json in /etc, root's alone, and hands
  // the bridge a copy. An operator running doctor as themselves cannot read
  // it — and reporting that as "the phone bridge does not run here" told them
  // the opposite of the truth on a host where it was serving.
  const probes = healthyProbes();
  probes.phoneConfig = async () => ({
    ok: true as const,
    source: "/etc/thicket (system unit)",
    unreadable: true as const,
  });
  const results = await runDoctor(ROSTER, probes);
  const line = results.find((r) => /phone\.json/.test(r.message));
  assert.ok(line, "no phone.json line");
  assert.equal(line.ok, true);
  assert.match(line.message, /readable only by root.*system unit/);
  assert.doesNotMatch(line.message, /does not run here/);
});

test("from a tagged host, a node it cannot see is not reported as absent", async () => {
  // A tagged machine's netmap holds only the peers the policy lets it reach,
  // so on the server that runs the fleet the fleet is invisible. Reporting
  // that as "no tailnet node named …" called four healthy agents missing.
  const probes = healthyProbes();
  probes.tailnetNodes = async () => ({
    nodes: [{ hostname: "core", tags: ["tag:server"] }],
    selfTags: ["tag:server"],
    selfHostname: "core",
  });
  const results = await runDoctor(ROSTER, probes);
  const line = results.find((r) => r.check === "tailnet" && r.agent === "hearth");
  assert.ok(line, "no tailnet line for hearth");
  assert.equal(line.ok, true, "an unverifiable check was reported as a failure");
  assert.match(line.message, /not in this host's view/);
  assert.match(line.message, /core is tagged \(tag:server\)/);
  assert.doesNotMatch(line.message, /no tailnet node named/);

  // From a member device the same absence is a real one.
  probes.tailnetNodes = async () => ({
    nodes: [{ hostname: "laptop", tags: [] }],
    selfTags: [],
    selfHostname: "laptop",
  });
  const fromMember = await runDoctor(ROSTER, probes);
  const strict = fromMember.find((r) => r.check === "tailnet" && r.agent === "hearth");
  assert.ok(strict);
  assert.equal(strict.ok, false);
  assert.match(strict.message, /no tailnet node named thicket-hearth/);
});

test("doctor says the open default out loud, and how to close it", async () => {
  const results = await runDoctor(ROSTER, healthyProbes());
  const reach = results.filter((r) => r.check === "reach");
  assert.equal(reach.length, 2, "one per agent");
  assert.ok(
    reach.every((r) => r.ok),
    "an open fleet is a fact to report, not a failure",
  );
  assert.match(
    reach.find((r) => r.agent === "hearth")!.message,
    /anyone in the workspace can open a turn as hearth@home, in any channel it is invited to/,
  );
  assert.match(reach[0]!.message, /constrain it with reach\.operators/);
});

test("a constrained agent is described by its constraints, with no hint to add one", async () => {
  const roster = parseRoster(`
agents:
  hearth:
    host: home
    user: hearth
    description: Personal assistant agent.
    tag: tag:thicket-hearth
    harness: { type: claude-agent-sdk, cwd: /home/hearth, model: claude-opus-5 }
    workspaces: { homestead: /home/hearth/src/homestead }
    channels: { "#ops": homestead }
    reach: { channels: listed, operators: [U0OPERATOR1] }
`);
  const results = await runDoctor(roster, healthyProbes());
  const reach = results.find((r) => r.check === "reach")!;
  assert.equal(
    reach.message,
    "1 operator can open a turn as hearth@home, in 1 listed channel (#ops)",
  );
});
