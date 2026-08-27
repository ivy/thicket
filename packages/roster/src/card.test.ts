import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { AgentCard } from "@a2a-js/sdk";

import { parseRoster } from "./schema.js";
import { agentUrl, toAgentCard, TAILNET_PEER_TAG_SCHEME } from "./card.js";

const roster = parseRoster(
  readFileSync(new URL("../fixtures/agents.yaml", import.meta.url), "utf8"),
);

const cards = Object.entries(roster.agents).map(([name, entry]) =>
  toAgentCard(name, entry),
);

test("fixture produces four cards with roster identity", () => {
  assert.equal(cards.length, 4);
  const hearth = cards.find((c) => c.name === "hearth");
  assert.ok(hearth);
  assert.equal(hearth.description, roster.agents.hearth?.description);
  assert.equal(hearth.capabilities?.streaming, true);
  assert.equal(hearth.skills.length, 1);
  assert.equal(hearth.skills[0]?.id, "email-triage");
  assert.deepEqual(hearth.skills[0]?.tags, ["email", "personal"]);
});

test("interface URL derives from the tailnet tag", () => {
  const hearth = roster.agents.hearth;
  assert.ok(hearth);
  assert.equal(agentUrl(hearth), "https://thicket-hearth/a2a/v1");
  assert.equal(
    agentUrl(hearth, { tailnetDomain: "example.ts.net" }),
    "https://thicket-hearth.example.ts.net/a2a/v1",
  );
  const card = toAgentCard("hearth", hearth, { tailnetDomain: "example.ts.net" });
  assert.equal(
    card.supportedInterfaces[0]?.url,
    "https://thicket-hearth.example.ts.net/a2a/v1",
  );
  assert.equal(card.supportedInterfaces[0]?.protocolBinding, "JSONRPC");
});

test("security scheme requires the agent's own tag", () => {
  for (const card of cards) {
    const scheme = card.securitySchemes[TAILNET_PEER_TAG_SCHEME];
    assert.ok(scheme, `${card.name} missing ${TAILNET_PEER_TAG_SCHEME} scheme`);
    assert.equal(scheme.scheme?.$case, "mtlsSecurityScheme");
    const requirement = card.securityRequirements[0]?.schemes[TAILNET_PEER_TAG_SCHEME];
    assert.ok(requirement);
    assert.equal(requirement.list.length, 1);
    assert.match(requirement.list[0] ?? "", /^tag:thicket-/);
  }
});

test("cards round-trip through the SDK's AgentCard JSON codec", () => {
  for (const card of cards) {
    const json = JSON.parse(JSON.stringify(AgentCard.toJSON(card)));
    const back = AgentCard.fromJSON(json);
    assert.deepEqual(back, card, `round-trip changed card for ${card.name}`);
  }
});
