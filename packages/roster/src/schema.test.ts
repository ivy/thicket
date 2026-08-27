import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { parseRoster, RosterValidationError } from "./schema.js";

const fixture = readFileSync(
  new URL("../fixtures/agents.yaml", import.meta.url),
  "utf8",
);

test("fixture with four agents parses", () => {
  const roster = parseRoster(fixture);
  assert.deepEqual(Object.keys(roster.agents).sort(), [
    "forge",
    "hearth",
    "lookout",
    "scribe",
  ]);
  assert.equal(roster.agents.hearth?.harness.model, "claude-opus-5");
  assert.equal(roster.agents.hearth?.skills[0]?.id, "email-triage");
});

test("context and queueing default to native and harness when omitted", () => {
  const roster = parseRoster(fixture);
  // scribe and lookout omit both fields in the fixture
  assert.equal(roster.agents.scribe?.context, "native");
  assert.equal(roster.agents.scribe?.queueing, "harness");
  assert.equal(roster.agents.lookout?.context, "native");
  assert.equal(roster.agents.lookout?.queueing, "harness");
  // forge sets both explicitly; defaults must not clobber them
  assert.equal(roster.agents.forge?.context, "replay");
  assert.equal(roster.agents.forge?.queueing, "bridge");
});

test("sessionTtlSeconds defaults to 300 when omitted", () => {
  const roster = parseRoster(fixture);
  // forge omits it in the fixture
  assert.equal(roster.agents.forge?.harness.sessionTtlSeconds, 300);
  assert.equal(roster.agents.scribe?.harness.sessionTtlSeconds, 600);
});

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

test("invalid config names the offending path", () => {
  const broken = {
    agents: {
      hearth: {
        ...minimalAgent,
        skills: [{ id: "", name: "Email triage", description: "Sorts mail." }],
      },
    },
  };
  assert.throws(
    () => parseRoster(JSON.stringify(broken)),
    (err: unknown) => {
      assert.ok(err instanceof RosterValidationError);
      assert.match(err.message, /agents\.hearth\.skills\[0\]\.id/);
      return true;
    },
  );
});

test("duplicate agent names (YAML keys) are rejected", () => {
  const dupNames = `
agents:
  hearth:
    host: home
    user: hearth
    description: An agent.
    tag: tag:thicket-hearth
    harness: { type: claude-agent-sdk, cwd: /home/hearth, model: claude-opus-5 }
  hearth:
    host: home
    user: hearth2
    description: Another agent.
    tag: tag:thicket-hearth2
    harness: { type: claude-agent-sdk, cwd: /home/hearth2, model: claude-opus-5 }
`;
  assert.throws(
    () => parseRoster(dupNames),
    (err: unknown) => {
      assert.ok(err instanceof RosterValidationError);
      assert.match(err.message, /hearth/);
      return true;
    },
  );
});

test("duplicate tags are rejected", () => {
  const broken = yamlish({
    hearth: minimalAgent,
    forge: { ...minimalAgent, user: "forge" },
  });
  assert.throws(
    () => parseRoster(broken),
    (err: unknown) => {
      assert.ok(err instanceof RosterValidationError);
      assert.match(err.message, /agents\.forge\.tag: duplicate tag tag:thicket-hearth/);
      return true;
    },
  );
});

test("duplicate (host, user) pairs are rejected", () => {
  const broken = yamlish({
    hearth: minimalAgent,
    forge: { ...minimalAgent, tag: "tag:thicket-forge" },
  });
  assert.throws(
    () => parseRoster(broken),
    (err: unknown) => {
      assert.ok(err instanceof RosterValidationError);
      assert.match(err.message, /agents\.forge: duplicate \(host, user\) pair \(home, hearth\)/);
      return true;
    },
  );
});

test("unparseable YAML is a RosterValidationError", () => {
  assert.throws(
    () => parseRoster("agents: {unclosed: ["),
    (err: unknown) => err instanceof RosterValidationError,
  );
});

test("attachments default to accepted, and an agent may refuse them", () => {
  const roster = parseRoster(fixture);
  assert.equal(roster.agents.hearth?.harness.attachments, "accept");
  const refusing = parseRoster(
    JSON.stringify({
      agents: {
        hearth: {
          ...minimalAgent,
          harness: { ...minimalAgent.harness, attachments: "reject" },
        },
      },
    }),
  );
  assert.equal(refusing.agents.hearth?.harness.attachments, "reject");
  assert.throws(
    () =>
      parseRoster(
        JSON.stringify({
          agents: {
            hearth: {
              ...minimalAgent,
              harness: { ...minimalAgent.harness, attachments: "sometimes" },
            },
          },
        }),
      ),
    (err: unknown) => {
      assert.ok(err instanceof RosterValidationError);
      assert.match(err.message, /agents\.hearth\.harness\.attachments/);
      return true;
    },
  );
});

test("permissionMode defaults to auto and rejects bypassPermissions", () => {
  const roster = parseRoster(fixture);
  assert.equal(roster.agents.hearth?.harness.permissionMode, "auto");
  assert.throws(
    () =>
      parseRoster(
        JSON.stringify({
          agents: {
            hearth: {
              ...minimalAgent,
              harness: { ...minimalAgent.harness, permissionMode: "bypassPermissions" },
            },
          },
        }),
      ),
    (err: unknown) => {
      assert.ok(err instanceof RosterValidationError);
      assert.match(err.message, /agents\.hearth\.harness\.permissionMode/);
      return true;
    },
  );
});

test("persona is optional, carried verbatim, and must not be empty", () => {
  const roster = parseRoster(fixture);
  assert.equal(roster.agents.hearth?.persona, undefined, "fixture sets no persona");

  const withPersona = parseRoster(`
agents:
  hearth:
    host: home
    user: hearth
    description: A test agent with a persona block that is long enough to satisfy Slack copy.
    tag: tag:thicket-hearth
    persona: |-
      You are warm and terse.
      Silence is a valid outcome.
    harness: { type: claude-agent-sdk, cwd: /home/hearth, model: claude-opus-5 }
`);
  assert.equal(
    withPersona.agents.hearth?.persona,
    "You are warm and terse.\nSilence is a valid outcome.",
  );

  assert.throws(
    () =>
      parseRoster(`
agents:
  hearth:
    host: home
    user: hearth
    description: A test agent whose persona is empty, which must be rejected loudly.
    tag: tag:thicket-hearth
    persona: ""
    harness: { type: claude-agent-sdk, cwd: /home/hearth, model: claude-opus-5 }
`),
    RosterValidationError,
  );
});
