import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { phoneEnabledAgents } from "./phone.js";
import { parseRoster, RosterValidationError } from "./schema.js";

const fixture = readFileSync(new URL("../fixtures/agents.yaml", import.meta.url), "utf8");

const minimalAgent = {
  host: "home",
  user: "hearth",
  description: "An agent.",
  tag: "tag:thicket-hearth",
  harness: { type: "claude-agent-sdk", cwd: "/home/hearth", model: "claude-opus-5" },
};

function yamlish(agents: Record<string, unknown>): string {
  return JSON.stringify({ agents });
}

function rejects(source: string, pattern: RegExp): void {
  assert.throws(
    () => parseRoster(source),
    (err: unknown) => {
      assert.ok(err instanceof RosterValidationError);
      assert.match(err.message, pattern);
      return true;
    },
  );
}

test("phone defaults to off, with no spoken name and a day's resume window", () => {
  const roster = parseRoster(yamlish({ hearth: minimalAgent }));
  assert.deepEqual(roster.agents.hearth?.phone, {
    enabled: false,
    aliases: [],
    resumeWindowSeconds: 86_400,
  });
});

test("only enabled agents are offered on a call, even when others are named", () => {
  const roster = parseRoster(fixture);
  assert.equal(roster.agents.forge?.phone.spokenName, "Forge", "forge is named");
  assert.equal(roster.agents.forge?.phone.enabled, false, "but not enabled");
  assert.deepEqual(phoneEnabledAgents(roster), [
    { name: "hearth", spokenName: "Hearth", aliases: ["home", "the house"], resumeWindowSeconds: 3600 },
  ]);
});

test("a phone-enabled agent needs a spoken name", () => {
  rejects(
    yamlish({ hearth: { ...minimalAgent, phone: { enabled: true } } }),
    /agents\.hearth\.phone\.spokenName: a phone-enabled agent needs a spokenName/,
  );
});

test("duplicate aliases fail validation naming both agents", () => {
  rejects(
    yamlish({
      hearth: { ...minimalAgent, phone: { enabled: true, spokenName: "Hearth", aliases: ["home"] } },
      forge: {
        ...minimalAgent,
        user: "forge",
        tag: "tag:thicket-forge",
        phone: { enabled: true, spokenName: "Forge", aliases: ["Home"] },
      },
    }),
    /agents\.forge\.phone\.aliases\[0\]: duplicate spoken name "Home" \(also used by agents\.hearth\)/,
  );
  // A spoken name is a handle too: an alias may not take another agent's name.
  rejects(
    yamlish({
      hearth: { ...minimalAgent, phone: { spokenName: "Hearth" } },
      forge: { ...minimalAgent, user: "forge", tag: "tag:thicket-forge", phone: { spokenName: "Forge", aliases: ["hearth"] } },
    }),
    /agents\.forge\.phone\.aliases\[0\]: duplicate spoken name "hearth" \(also used by agents\.hearth\)/,
  );
});

test("the roster cannot hold a number: unknown phone keys are refused", () => {
  rejects(
    yamlish({ hearth: { ...minimalAgent, phone: { enabled: true, spokenName: "Hearth", number: "+15550100001" } } }),
    /agents\.hearth\.phone: .*number/,
  );
});
