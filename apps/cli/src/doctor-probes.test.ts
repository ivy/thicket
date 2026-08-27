import test from "node:test";
import assert from "node:assert/strict";

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
    /thicket-hearth does not resolve from here — no tailnet on this host/,
  );
});

test("an agent absent from the roster still fails loudly", async () => {
  const probes = realProbes({ roster: ROSTER });
  await assert.rejects(() => probes.fetchCard("stranger"), /missing from roster/);
});
