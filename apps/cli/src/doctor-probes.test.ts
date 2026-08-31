import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseRoster } from "@thicket/roster";

import { realProbes } from "./doctor-probes.js";

const ROSTER = parseRoster(`
agents:
  hearth:
    host: home
    user: hearth
    description: Personal assistant agent for probing the doctor's card check.
    tag: tag:thicket-hearth
    harness: { type: claude-agent-sdk, cwd: /home/hearth, model: claude-opus-5 }
`);

test("the card check resolves the agent through the roster and reads the card", async () => {
  const urls: string[] = [];
  const probes = realProbes({
    roster: ROSTER,
    tailnetDomain: "tail42.ts.net",
    fetchImpl: (async (url: string) => {
      urls.push(String(url));
      return Response.json({ name: "hearth" });
    }) as unknown as typeof fetch,
  });
  const card = await probes.fetchCard("hearth");
  assert.equal(card.name, "hearth");
  assert.deepEqual(urls, ["https://thicket-hearth.tail42.ts.net/.well-known/agent-card.json"]);
});

test("an endpoint override wins, the dev rig's stand-in for the tailnet", async () => {
  const urls: string[] = [];
  const probes = realProbes({
    roster: ROSTER,
    endpointOverrides: { hearth: "http://127.0.0.1:8791" },
    fetchImpl: (async (url: string) => {
      urls.push(String(url));
      return Response.json({ name: "hearth" });
    }) as unknown as typeof fetch,
  });
  await probes.fetchCard("hearth");
  assert.deepEqual(urls, ["http://127.0.0.1:8791/.well-known/agent-card.json"]);
});

test("an unresolvable tailnet name explains itself instead of saying 'fetch failed'", async () => {
  const probes = realProbes({
    roster: ROSTER,
    fetchImpl: (async () => {
      throw new Error("fetch failed", {
        cause: new Error("getaddrinfo ENOTFOUND thicket-hearth"),
      });
    }) as unknown as typeof fetch,
  });
  await assert.rejects(
    () => probes.fetchCard("hearth"),
    /thicket-hearth does not resolve over this host's own network — no tailnet on this host/,
  );
});

test("an agent absent from the roster still fails loudly", async () => {
  const probes = realProbes({ roster: ROSTER });
  await assert.rejects(() => probes.fetchCard("stranger"), /missing from roster/);
});

// An edge component deployed as a system unit keeps its state in /var/lib,
// and doctor is run by the operator from their own account. Reading only
// this process's XDG state dir means a bridge that is serving perfectly
// reports as absent — which is the shape of "no problems found" and the
// worst way to be wrong.
test("the health probe reads the system layout before this account's", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "doctor-state-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, "thicket", "bridge"), { recursive: true });
  writeFileSync(
    join(home, "thicket", "bridge", "health.json"),
    JSON.stringify({ ts: new Date().toISOString(), agents: [] }),
  );

  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = home;
  t.after(() => {
    if (previous === undefined) {
      delete process.env.XDG_STATE_HOME;
    } else {
      process.env.XDG_STATE_HOME = previous;
    }
  });

  const health = await realProbes().bridgeHealth();
  assert.ok(health, "the account's own state dir was not read");
  // The line doctor prints has to say which layout answered, or a wrong
  // inference is invisible.
  assert.match(String(health.source), /this account/);
});

test("startsAtBoot names the mechanism it asked about", async () => {
  const result = await realProbes().startsAtBoot("hearth", process.env.USER ?? "root");
  assert.match(result.mechanism, process.platform === "darwin" ? /launchd/ : /loginctl/);
});
