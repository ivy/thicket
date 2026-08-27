import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import type { AgentCard } from "@a2a-js/sdk";
import { parseRoster, toAgentCard } from "@thicket/roster";

import {
  AGENT_DESCRIPTION_MAX,
  LONG_DESCRIPTION_MIN,
  ManifestRenderError,
  SUGGESTED_PROMPTS_MAX,
  toSlackManifest,
  truncateAtWord,
} from "./manifest.js";

const roster = parseRoster(
  readFileSync(new URL("../fixtures/roster.yaml", import.meta.url), "utf8"),
);

function card(name: string): AgentCard {
  const entry = roster.agents[name];
  assert.ok(entry, `fixture agent ${name}`);
  return toAgentCard(name, entry);
}

function goldenPath(name: string): URL {
  return new URL(`../fixtures/expected/${name}.manifest.json`, import.meta.url);
}

test("golden files: fixture roster renders to the checked-in manifests", () => {
  for (const name of Object.keys(roster.agents)) {
    const { manifest } = toSlackManifest(card(name));
    const expected = JSON.parse(readFileSync(goldenPath(name), "utf8"));
    assert.deepEqual(
      JSON.parse(JSON.stringify(manifest)),
      expected,
      `manifest drift for agent ${name} — if intentional, regenerate fixtures/expected/${name}.manifest.json`,
    );
  }
});

test("fixed settings: socket mode on, no request_url, agent_view not assistant_view", () => {
  for (const name of Object.keys(roster.agents)) {
    const { manifest } = toSlackManifest(card(name));
    assert.equal(manifest.settings.socket_mode_enabled, true);
    const raw = JSON.stringify(manifest);
    assert.ok(!raw.includes("request_url"), "no request_url anywhere");
    assert.ok(!raw.includes("assistant_view"), "no assistant_view anywhere");
    assert.ok(manifest.features.agent_view, "agent_view present");
  }
});

test("a terse description fails loudly, naming the agent", () => {
  const terse: AgentCard = {
    ...card("hearth"),
    name: "scribe",
    description: "Writes docs.",
    skills: [],
  };
  assert.throws(
    () => toSlackManifest(terse),
    (err: Error) => {
      assert.ok(err instanceof ManifestRenderError);
      assert.match(err.message, /scribe/);
      assert.match(err.message, new RegExp(String(LONG_DESCRIPTION_MIN)));
      return true;
    },
  );
});

test("agent_description over 300 characters truncates on a word boundary", () => {
  const wordy = {
    ...card("hearth"),
    description:
      "This agent handles an unreasonably broad portfolio of responsibilities including " +
      "calendar coordination, electronic mail triage and prioritization, longform note " +
      "gardening inside an Obsidian vault, grocery list reconciliation, package tracking, " +
      "appointment scheduling, follow-up reminders, travel planning contingencies, and " +
      "weekly review preparation for the household at large.",
  };
  assert.ok(wordy.description.length > AGENT_DESCRIPTION_MAX);
  const { manifest } = toSlackManifest(wordy);
  const rendered = manifest.features.agent_view.agent_description;
  assert.ok(rendered.length <= AGENT_DESCRIPTION_MAX, `rendered length ${rendered.length}`);
  assert.ok(rendered.endsWith("…"));
  // Word boundary: strip the ellipsis and the remainder must be a prefix
  // of the original ending at a space.
  const stem = rendered.slice(0, -1);
  assert.ok(wordy.description.startsWith(stem));
  assert.equal(wordy.description.charAt(stem.length), " ");
});

test("iconUrl produces a warning naming the app; no icon field exists", () => {
  const iconized = { ...card("hearth"), iconUrl: "https://example.com/hearth.png" };
  const { manifest, warnings } = toSlackManifest(iconized);
  assert.equal(warnings.filter((w) => /icon/.test(w)).length, 1);
  assert.match(warnings[0]!, /hearth/);
  assert.ok(!JSON.stringify(manifest).includes("icon"), "manifest carries no icon key");
});

test("no iconUrl, no warning", () => {
  const { warnings } = toSlackManifest(card("hearth"));
  assert.deepEqual(warnings, []);
});

test("suggested prompts cap at Slack's limit with a warning", () => {
  const { manifest, warnings } = toSlackManifest(card("forge"));
  assert.equal(manifest.features.agent_view.suggested_prompts.length, SUGGESTED_PROMPTS_MAX);
  assert.equal(warnings.filter((w) => /suggested prompts/.test(w)).length, 1);
});

test("field mapping: names, descriptions, prompts, actions", () => {
  const { manifest } = toSlackManifest(card("hearth"));
  assert.equal(manifest.display_information.name, "hearth");
  assert.equal(manifest.features.bot_user.display_name, "hearth");
  assert.deepEqual(manifest.features.agent_view.actions, [
    { name: "Email triage", description: "Reads and sorts the inbox, drafts replies for review." },
    { name: "Calendar management", description: "Schedules, reschedules, and flags conflicts before they bite." },
  ]);
  assert.deepEqual(manifest.features.agent_view.suggested_prompts[0], {
    title: "Email triage",
    message: "What needs a reply today?",
  });
  assert.ok(manifest.display_information.long_description.length >= LONG_DESCRIPTION_MIN);
  assert.match(manifest.display_information.long_description, /Skills:/);
});

test("truncateAtWord leaves short text alone and never exceeds max", () => {
  assert.equal(truncateAtWord("short", 10), "short");
  for (const max of [10, 25, 80]) {
    const out = truncateAtWord("a b ".repeat(100), max);
    assert.ok(out.length <= max);
  }
});
