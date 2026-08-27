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

test("formatResults marks failures loudly and names the agent", async () => {
  const probes = healthyProbes();
  probes.lingeringEnabled = async () => false;
  const lines = formatResults(await runDoctor(ROSTER, probes));
  assert.ok(lines.some((l) => l.startsWith("FAIL [lingering] hearth:")));
  assert.ok(lines.some((l) => l.startsWith("ok ")));
});
