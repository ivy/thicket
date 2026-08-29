import test from "node:test";
import assert from "node:assert/strict";

import { activity, describeToolUse, parseAgentActivity } from "./activity.js";

test("tool titles read as what the agent is doing", () => {
  const cases: [string, unknown, string][] = [
    ["Bash", { command: "vm_stat", description: "Check memory pressure" }, "Check memory pressure"],
    ["Bash", { command: "vm_stat" }, "Running a command"],
    ["Read", { file_path: "/home/hearth/src/engine.ts" }, "Reading engine.ts"],
    ["Edit", { file_path: "/home/hearth/src/engine.ts" }, "Editing engine.ts"],
    ["Grep", { pattern: "TODO" }, "Searching for TODO"],
    ["WebFetch", { url: "https://docs.slack.dev/ai/x" }, "Fetching docs.slack.dev"],
    ["Task", { subagent_type: "Explore", description: "find it" }, "Delegating to Explore"],
    ["TodoWrite", { todos: [] }, "Updating its plan"],
    ["mcp__qmd__query", { q: "x" }, "query (qmd)"],
    ["SomethingNew", {}, "Running SomethingNew"],
  ];
  for (const [name, input, expected] of cases) {
    assert.equal(describeToolUse(name, input).title, expected, name);
  }
});

test("each kind of step carries its own icon, and unknown tools the fallback", () => {
  const cases: [string, string][] = [
    ["Bash", "code"],
    ["BashOutput", "code"],
    ["Read", "file"],
    ["Edit", "edit"],
    ["Write", "edit"],
    ["NotebookEdit", "edit"],
    ["Grep", "refine"],
    ["Glob", "refine"],
    ["WebFetch", "globe"],
    ["WebSearch", "globe"],
    ["TodoWrite", "clipboard"],
    ["Task", "bot"],
    ["Agent", "bot"],
    ["AskUserQuestion", "help"],
    ["mcp__thicket__post_message", "comment"],
    ["mcp__thicket__upload_file", "upload"],
    ["mcp__thicket__read_thread", "book"],
    ["mcp__thicket__read_channel", "book"],
    ["mcp__thicket__routine_create", "calendar"],
    ["mcp__thicket__routine_list", "calendar"],
    ["mcp__thicket__something_new", "gear"],
    ["mcp__qmd__query", "gear"],
    ["SomethingNew", "gear"],
  ];
  for (const [name, expected] of cases) {
    assert.equal(describeToolUse(name, {}).icon, expected, name);
  }
});

test("the icon rides along on the card, and only when there is one", () => {
  assert.equal(activity("toolu_1", "running", describeToolUse("Bash", {})).icon, "code");
  assert.equal("icon" in activity("toolu_1", "done", { title: "t" }), false);
});

test("details carry the command or path when there is one", () => {
  assert.equal(describeToolUse("Bash", { command: "vm_stat" }).details, "vm_stat");
  assert.equal(
    describeToolUse("Read", { file_path: "/home/hearth/a.ts" }).details,
    "/home/hearth/a.ts",
  );
  assert.equal(describeToolUse("TodoWrite", {}).details, undefined);
});

test("a card is flattened and clipped to what a card can show", () => {
  const card = activity("toolu_1", "running", {
    title: "Check\n  memory",
    details: "x".repeat(400),
  });
  assert.equal(card.title, "Check memory");
  assert.equal(card.details?.length, 200);
  assert.ok(card.details?.endsWith("…"));
});

test("an empty details field is omitted rather than sent blank", () => {
  assert.equal("details" in activity("toolu_1", "done", { title: "t", details: "  " }), false);
  assert.equal("details" in activity("toolu_1", "done", { title: "t" }), false);
});

test("malformed activity payloads are rejected, not rendered", () => {
  assert.equal(parseAgentActivity(null), undefined);
  assert.equal(parseAgentActivity({ id: "", title: "t", status: "running" }), undefined);
  assert.equal(parseAgentActivity({ id: "a", title: "t", status: "spinning" }), undefined);
  assert.equal(parseAgentActivity({ id: "a", title: 7, status: "running" }), undefined);
  assert.deepEqual(parseAgentActivity({ id: "a", title: "t", status: "done", extra: 1 }), {
    id: "a",
    title: "t",
    status: "done",
  });
});

test("an icon survives the wire only when it is one Slack will draw", () => {
  assert.equal(parseAgentActivity({ id: "a", title: "t", status: "done", icon: "code" })?.icon, "code");
  const odd = parseAgentActivity({ id: "a", title: "t", status: "done", icon: ":tada:" });
  assert.ok(odd !== undefined, "the card itself is still rendered");
  assert.equal("icon" in odd, false);
  assert.equal("icon" in parseAgentActivity({ id: "a", title: "t", status: "done", icon: 7 })!, false);
});
