import test from "node:test";
import assert from "node:assert/strict";

import type { AgentQuestion } from "@thicket/executor";

import {
  answerText,
  decodeAnswers,
  isForm,
  isQuestionAction,
  questionFallbackText,
  renderAnsweredBlocks,
  renderQuestionBlocks,
} from "./questions.js";

const deploy: AgentQuestion = {
  question: "Which environment should I deploy to?",
  header: "Target",
  multiSelect: false,
  options: [
    { label: "staging", description: "Rehearse first" },
    { label: "production", description: "Straight to the real thing" },
  ],
};

const features: AgentQuestion = {
  question: "Which features do you want on?",
  header: "Features",
  multiSelect: true,
  options: [{ label: "metrics" }, { label: "tracing" }, { label: "profiling" }],
};

type Block = { type: string; block_id?: string; elements?: Record<string, unknown>[] };

test("one question, one answer: the options are buttons, and a tap is the answer", () => {
  assert.equal(isForm([deploy]), false);
  const blocks = renderQuestionBlocks([deploy]) as Block[];
  assert.deepEqual(
    blocks.map((b) => b.type),
    ["section", "actions"],
  );
  assert.equal(
    (blocks[0] as unknown as { text: { text: string } }).text.text,
    "*Target*\nWhich environment should I deploy to?",
    "the header sits on its own line above the question",
  );
  const buttons = blocks[1]!.elements!;
  assert.deepEqual(
    buttons.map((b) => b.type),
    ["button", "button"],
  );
  assert.deepEqual(
    buttons.map((b) => (b.text as { text: string }).text),
    ["staging", "production"],
  );
  const tapped = buttons[1]!;
  const decoded = decodeAnswers([deploy], [
    { actionId: tapped.action_id as string, blockId: "thicket_q:0", value: tapped.value as string },
  ]);
  assert.deepEqual(decoded, { answers: [[1]] });
  assert.equal(answerText([deploy], [[1]]), "Target: production");
});

test("pick-many or several questions: a group per question and one Submit", () => {
  assert.equal(isForm([features]), true);
  assert.equal(isForm([deploy, deploy]), true);
  const blocks = renderQuestionBlocks([deploy, features]) as Block[];
  assert.deepEqual(
    blocks.map((b) => b.type),
    ["section", "actions", "section", "actions", "actions"],
  );
  assert.equal(blocks[1]!.elements![0]!.type, "radio_buttons");
  assert.equal(blocks[3]!.elements![0]!.type, "checkboxes");
  const submit = blocks[4]!.elements![0]!;
  assert.equal(submit.type, "button");
  assert.equal(submit.action_id, "thicket_q:submit");
});

test("a form resolves on Submit from the message's current state", () => {
  const changed = decodeAnswers(
    [deploy, features],
    [{ actionId: "thicket_q:answer:1", blockId: "thicket_q:1", selected: ["1:0"] }],
  );
  assert.equal(changed, undefined, "a selection change waits for Submit");

  const submitted = decodeAnswers(
    [deploy, features],
    [{ actionId: "thicket_q:submit", blockId: "thicket_q:controls", value: "submit" }],
    {
      "thicket_q:0": { "thicket_q:answer:0": ["0:0"] },
      "thicket_q:1": { "thicket_q:answer:1": ["1:0", "1:2"] },
    },
  );
  assert.deepEqual(submitted, { answers: [[0], [0, 2]] });
  assert.equal(
    answerText([deploy, features], [[0], [0, 2]]),
    "Target: staging\nFeatures: metrics, profiling",
  );
});

test("Submit with a question left blank is incomplete, not an answer", () => {
  const decoded = decodeAnswers(
    [deploy, features],
    [{ actionId: "thicket_q:submit", blockId: "thicket_q:controls", value: "submit" }],
    { "thicket_q:0": { "thicket_q:answer:0": ["0:1"] } },
  );
  assert.deepEqual(decoded, { incomplete: true });
});

test("without state in the payload, the selections carried by the actions stand in", () => {
  const decoded = decodeAnswers(
    [features],
    [
      { actionId: "thicket_q:answer:0", blockId: "thicket_q:0", selected: ["0:1"] },
      { actionId: "thicket_q:submit", blockId: "thicket_q:controls", value: "submit" },
    ],
  );
  assert.deepEqual(decoded, { answers: [[1]] });
});

test("taps that are not ours, or point at options that do not exist, resolve to nothing", () => {
  assert.equal(isQuestionAction({ actionId: "somebody_else", blockId: "b" }), false);
  assert.equal(decodeAnswers([deploy], [{ actionId: "somebody_else", blockId: "b", value: "0:0" }]), undefined);
  assert.equal(
    decodeAnswers([deploy], [{ actionId: "thicket_q:answer:0:9", blockId: "thicket_q:0", value: "0:9" }]),
    undefined,
  );
});

test("an answered question shows the choice and leaves nothing to tap", () => {
  const blocks = renderAnsweredBlocks([deploy], [[0]], "U-human") as Block[];
  assert.deepEqual(
    blocks.map((b) => b.type),
    ["section", "context"],
  );
  const note = (blocks[1]!.elements![0] as { text: string }).text;
  assert.match(note, /staging/);
  assert.match(note, /<@U-human>/);
  assert.equal(JSON.stringify(blocks).includes('"button"'), false);
});

test("labels are clipped to what Slack accepts, and the fallback is the question", () => {
  const long: AgentQuestion = {
    question: "Q?",
    multiSelect: false,
    options: [{ label: "x".repeat(200) }, { label: "y" }],
  };
  const blocks = renderQuestionBlocks([long]) as Block[];
  const label = (blocks[1]!.elements![0]!.text as { text: string }).text;
  assert.equal(label.length, 75);
  assert.equal(questionFallbackText([deploy, features]), `${deploy.question} ${features.question}`);
});
