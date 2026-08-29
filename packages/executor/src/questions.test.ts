import test from "node:test";
import assert from "node:assert/strict";

import { parseAgentQuestions } from "./questions.js";

const ask = {
  questions: [
    {
      question: "Which environment should I deploy to?",
      header: "Target",
      options: [
        { label: "staging", description: "The safe one" },
        { label: "production", description: "The real one" },
      ],
      multiSelect: false,
    },
  ],
};

test("an AskUserQuestion input becomes renderable questions", () => {
  assert.deepEqual(parseAgentQuestions(ask), [
    {
      question: "Which environment should I deploy to?",
      header: "Target",
      multiSelect: false,
      options: [
        { label: "staging", description: "The safe one" },
        { label: "production", description: "The real one" },
      ],
    },
  ]);
});

test("the bare list round-trips the same way, as it arrives in metadata", () => {
  const parsed = parseAgentQuestions(ask)!;
  assert.deepEqual(parseAgentQuestions(parsed), parsed);
});

test("shapes a client could not render are rejected whole", () => {
  assert.equal(parseAgentQuestions(undefined), undefined);
  assert.equal(parseAgentQuestions({ question: "x", options: ["a", "b"] }), undefined);
  assert.equal(parseAgentQuestions({ questions: [] }), undefined);
  assert.equal(
    parseAgentQuestions({ questions: [{ question: "x", options: [] }] }),
    undefined,
    "a question with no options is prose",
  );
  assert.equal(
    parseAgentQuestions({
      questions: [ask.questions[0], { question: "", options: [{ label: "a" }] }],
    }),
    undefined,
    "one bad question spoils the form: half a form is worse than prose",
  );
});

test("optional fields are omitted rather than sent blank", () => {
  const [q] = parseAgentQuestions({
    questions: [{ question: "Which?", options: [{ label: "a", description: "" }, { label: "b" }] }],
  })!;
  assert.equal("header" in q!, false);
  assert.equal(q!.multiSelect, false);
  assert.deepEqual(q!.options, [{ label: "a" }, { label: "b" }]);
});
