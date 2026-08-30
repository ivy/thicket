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
    harness: { type: claude-agent-sdk, cwd: /home/hearth, model: claude-opus-5 }
  forge:
    host: workshop
    user: forge
    description: CI fixer agent.
    tag: tag:thicket-forge
    harness: { type: claude-agent-sdk, cwd: /home/forge, model: claude-sonnet-5 }
`);

function healthyProbes(): DoctorProbes {
  return {
    fetchCard: async (agent) => ({ name: agent }),
    tailnetNodes: async () => [
      { hostname: "thicket-hearth", tags: ["tag:thicket-hearth"] },
      { hostname: "thicket-forge", tags: ["tag:thicket-forge"] },
    ],
    slackApp: async () => ({ installed: true, socketMode: true }),
    workspaceAppUsage: async () => ({ installed: 4, cap: 10 }),
    lingeringEnabled: async () => true,
    phoneNumber: async () => ({ number: "+15550100002", drift: [] }),
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
  probes.tailnetNodes = async () => [
    { hostname: "thicket-hearth", tags: [] },
    { hostname: "thicket-forge", tags: ["tag:thicket-forge"] },
  ];
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
  probes.tailnetNodes = async () => [
    { hostname: "thicket-forge", tags: ["tag:thicket-forge"] },
  ];
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
  probes.lingeringEnabled = async (_agent, user) => user !== "forge";
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
  probes.lingeringEnabled = async () => false;
  const lines = formatResults(await runDoctor(ROSTER, probes));
  assert.ok(lines.some((l) => l.startsWith("FAIL [lingering] hearth:")));
  assert.ok(lines.some((l) => l.startsWith("ok ")));
});

test("a throwing probe becomes a failed check and every other check still runs", async () => {
  const probes = healthyProbes();
  probes.tailnetNodes = async () => {
    throw new Error("spawn tailscale ENOENT");
  };
  probes.lingeringEnabled = async () => {
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
