import type { AgentQuestion } from "@thicket/executor";

import type { BlockAction } from "./types.js";

/**
 * An agent's question as Slack UI. One question with one answer is a row
 * of buttons — a tap is the answer. Anything else (several questions, or
 * pick-many) is a form: a radio or checkbox group per question and one
 * Submit, because the agent expects every answer in a single reply.
 *
 * Action ids all start with the same prefix so the bridge can tell its own
 * taps from anything else that might share a socket.
 */

const PREFIX = "thicket_q";
const SUBMIT_ACTION = `${PREFIX}:submit`;

/** Slack caps button and option labels at 75 characters. */
const LABEL_MAX = 75;
/** ...and option descriptions and section text at 75 and 3000. */
const DESCRIPTION_MAX = 75;
const SECTION_MAX = 3000;

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function plain(text: string, max: number) {
  return { type: "plain_text", text: clip(text, max), emoji: true };
}

/** Section text keeps its line breaks; only the length is bounded. */
function mrkdwn(text: string) {
  const trimmed = text.trim();
  return {
    type: "mrkdwn",
    text: trimmed.length <= SECTION_MAX ? trimmed : `${trimmed.slice(0, SECTION_MAX - 1)}…`,
  };
}

function blockId(index: number): string {
  return `${PREFIX}:${index}`;
}

function actionId(index: number): string {
  return `${PREFIX}:answer:${index}`;
}

/** The value a tap carries: which question, which option. */
function optionValue(question: number, option: number): string {
  return `${question}:${option}`;
}

function parseOptionValue(value: string): { question: number; option: number } | undefined {
  const match = /^(\d+):(\d+)$/.exec(value);
  if (match === null) {
    return undefined;
  }
  return { question: Number(match[1]), option: Number(match[2]) };
}

function heading(q: AgentQuestion): string {
  return q.header === undefined ? q.question : `*${clip(q.header, LABEL_MAX)}*\n${q.question}`;
}

function optionElement(qi: number, q: AgentQuestion, oi: number) {
  const option = q.options[oi]!;
  return {
    text: plain(option.label, LABEL_MAX),
    value: optionValue(qi, oi),
    ...(option.description === undefined
      ? {}
      : { description: plain(option.description, DESCRIPTION_MAX) }),
  };
}

/** Whether the questions need a form, or a tap can answer outright. */
export function isForm(questions: AgentQuestion[]): boolean {
  return questions.length !== 1 || questions[0]!.multiSelect;
}

/** The Block Kit blocks presenting the questions. */
export function renderQuestionBlocks(questions: AgentQuestion[]): unknown[] {
  const blocks: unknown[] = [];
  questions.forEach((q, qi) => {
    blocks.push({ type: "section", block_id: `${PREFIX}:text:${qi}`, text: mrkdwn(heading(q)) });
    if (!isForm(questions)) {
      blocks.push({
        type: "actions",
        block_id: blockId(qi),
        elements: q.options.map((option, oi) => ({
          type: "button",
          action_id: `${actionId(qi)}:${oi}`,
          text: plain(option.label, LABEL_MAX),
          value: optionValue(qi, oi),
        })),
      });
      return;
    }
    blocks.push({
      type: "actions",
      block_id: blockId(qi),
      elements: [
        {
          type: q.multiSelect ? "checkboxes" : "radio_buttons",
          action_id: actionId(qi),
          options: q.options.map((_, oi) => optionElement(qi, q, oi)),
        },
      ],
    });
  });
  if (isForm(questions)) {
    blocks.push({
      type: "actions",
      block_id: `${PREFIX}:controls`,
      elements: [
        {
          type: "button",
          action_id: SUBMIT_ACTION,
          text: plain("Submit", LABEL_MAX),
          style: "primary",
          value: "submit",
        },
      ],
    });
  }
  return blocks;
}

/** The notification-tray fallback for a question message. */
export function questionFallbackText(questions: AgentQuestion[]): string {
  return questions.map((q) => q.question).join(" ");
}

/** One answer per question, as option indexes into its options. */
export type Answers = number[][];

/** True for a tap the bridge posted the element for. */
export function isQuestionAction(action: BlockAction): boolean {
  return action.actionId.startsWith(`${PREFIX}:`);
}

/**
 * Resolves what an interaction means for these questions: the answers, or
 * nothing when the tap was a selection change (the form waits for Submit)
 * or an id that does not belong here. `state` is the message's current
 * element values, which Slack sends with every interaction; `selected`
 * from the actions themselves is the fallback for a payload without it.
 */
export function decodeAnswers(
  questions: AgentQuestion[],
  actions: BlockAction[],
  state?: Record<string, Record<string, string[]>>,
): { answers: Answers } | { incomplete: true } | undefined {
  const ours = actions.filter(isQuestionAction);
  if (ours.length === 0) {
    return undefined;
  }
  if (!isForm(questions)) {
    const tap = ours.find((action) => action.value !== undefined);
    const parsed = tap?.value === undefined ? undefined : parseOptionValue(tap.value);
    if (parsed === undefined || parsed.question !== 0 || questions[0]!.options[parsed.option] === undefined) {
      return undefined;
    }
    return { answers: [[parsed.option]] };
  }
  if (!ours.some((action) => action.actionId === SUBMIT_ACTION)) {
    return undefined; // a selection changed; nothing to do until Submit
  }
  const answers: Answers = [];
  for (let qi = 0; qi < questions.length; qi += 1) {
    const fromState = state?.[blockId(qi)]?.[actionId(qi)];
    const fromAction = actions.find((action) => action.actionId === actionId(qi))?.selected;
    const values = fromState ?? fromAction ?? [];
    const picked = values
      .map(parseOptionValue)
      .filter((v): v is { question: number; option: number } => v !== undefined && v.question === qi)
      .map((v) => v.option)
      .filter((oi) => questions[qi]!.options[oi] !== undefined);
    if (picked.length === 0) {
      return { incomplete: true };
    }
    answers.push(picked);
  }
  return { answers };
}

/**
 * The reply the agent reads. It asked in its own words a turn ago, so the
 * answer names the decision and the choice, one line per question.
 */
export function answerText(questions: AgentQuestion[], answers: Answers): string {
  return questions
    .map((q, qi) => {
      const labels = (answers[qi] ?? []).map((oi) => q.options[oi]!.label).join(", ");
      return `${q.header ?? q.question}: ${labels}`;
    })
    .join("\n");
}

/** The question message after it was answered: the choice, nothing to tap. */
export function renderAnsweredBlocks(
  questions: AgentQuestion[],
  answers: Answers,
  userId: string,
): unknown[] {
  const blocks: unknown[] = [];
  questions.forEach((q, qi) => {
    blocks.push({ type: "section", text: mrkdwn(heading(q)) });
    const labels = (answers[qi] ?? []).map((oi) => q.options[oi]!.label).join(", ");
    blocks.push({
      type: "context",
      elements: [mrkdwn(`✓ ${labels} — chosen by <@${userId}>`)],
    });
  });
  return blocks;
}
