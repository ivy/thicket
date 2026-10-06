import test from "node:test";
import assert from "node:assert/strict";

import { carriedSteps, IS_COMPONENTS_V2, renderCard, STOP_ID, TEXT_LIMIT, textBudget } from "./card.js";
import type { CardStep } from "./state.js";

const steps: CardStep[] = [
  { id: "a", title: "Read agents.yaml", status: "done" },
  { id: "b", title: "Render manifests", status: "running" },
];

function flatten(components: unknown[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const visit = (c: unknown) => {
    const component = c as Record<string, unknown>;
    out.push(component);
    if (Array.isArray(component.components)) {
      component.components.forEach(visit);
    }
    if (component.accessory !== undefined) {
      visit(component.accessory);
    }
  };
  components.forEach(visit);
  return out;
}

test("a working card has Stop, steps, text, and the V2 flag", () => {
  const card = renderCard({ state: "working", status: "Working", steps, text: "Hello" });
  const all = flatten(card.components);

  assert.equal(card.flags, IS_COMPONENTS_V2);
  assert.deepEqual(card.allowed_mentions, { parse: [] });
  assert.ok(all.some((c) => c.type === 2 && c.custom_id === STOP_ID), "Stop button");
  const displays = all.filter((c) => c.type === 10).map((c) => c.content);
  assert.deepEqual(displays, ["**Working**", "✅ Read agents.yaml\n⏳ Render manifests", "Hello"]);
  assert.equal(all.length, 8, "eight components counting the nested ones");
});

test("empty steps and text leave their displays out, since a Text Display may not be empty", () => {
  const card = renderCard({ state: "working", status: "Working", steps: [], text: "" });
  const displays = flatten(card.components).filter((c) => c.type === 10);
  assert.equal(displays.length, 1);
});

test("a completed turn sheds the card: the text, then the steps as subtext", () => {
  const done = renderCard({ state: "completed", status: "Done", steps, text: "x" });
  assert.deepEqual(
    done.components.map((c) => (c as { type: number }).type),
    [10, 10],
    "two Text Displays and no container",
  );
  assert.equal((done.components[1] as { content: string }).content, "-# ✅ Read agents.yaml\n-# ⏳ Render manifests");
  const bare = renderCard({ state: "completed", status: "Done", steps: [], text: "" });
  assert.equal(bare.components.length, 1, "never an empty message");
});

test("a failed or stopped card keeps its container, without Stop, in a state colour", () => {
  const failed = renderCard({ state: "failed", status: "Failed", steps, text: "x" });
  const cancelled = renderCard({ state: "cancelled", status: "Stopped", steps, text: "x" });
  assert.ok(!flatten(failed.components).some((c) => c.type === 2));
  const colour = (card: { components: unknown[] }) => (card.components[0] as { accent_color: number }).accent_color;
  assert.notEqual(colour(failed), colour(cancelled));
});

test("a frozen card says so, and loses Stop", () => {
  const card = renderCard({ state: "frozen", status: "Working", steps, text: "x" });
  const all = flatten(card.components);
  assert.ok(!all.some((c) => c.type === 2));
  assert.ok(String(all.find((c) => c.type === 10)?.content).includes("continued below"));
});

test("the text budget is what the status and steps leave of the limit", () => {
  assert.equal(textBudget("Working", []), TEXT_LIMIT - "Working".length);
  const withSteps = textBudget("Working", steps);
  assert.equal(withSteps, TEXT_LIMIT - "Working".length - "✅ Read agents.yaml\n⏳ Render manifests".length);
});

test("a rollover carries the running steps and the last three closed", () => {
  const many: CardStep[] = [
    { id: "1", title: "one", status: "done" },
    { id: "2", title: "two", status: "done" },
    { id: "3", title: "three", status: "failed" },
    { id: "4", title: "four", status: "done" },
    { id: "5", title: "five", status: "running" },
    { id: "6", title: "six", status: "done" },
    { id: "7", title: "seven", status: "running" },
  ];
  assert.deepEqual(
    carriedSteps(many).map((s) => s.id),
    ["3", "4", "6", "5", "7"],
  );
});
