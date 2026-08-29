/**
 * A question the agent asked and stopped for. The structure comes from
 * AskUserQuestion's deferred tool input; it is carried on the
 * input-required status so a client can offer the options as something to
 * tap rather than something to retype. The answer is whatever the session
 * receives next — the same path a typed reply takes.
 */

/** Metadata key on an input-required status update carrying AgentQuestion[]. */
export const META_QUESTIONS = "thicket.questions";

export interface AgentQuestionOption {
  label: string;
  description?: string;
}

export interface AgentQuestion {
  question: string;
  /** Short chip naming the decision: "Deploy target". */
  header?: string;
  multiSelect: boolean;
  options: AgentQuestionOption[];
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function parseOption(value: unknown): AgentQuestionOption | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const { label, description } = value as Record<string, unknown>;
  if (!nonEmpty(label)) {
    return undefined;
  }
  return { label, ...(nonEmpty(description) ? { description } : {}) };
}

function parseQuestion(value: unknown): AgentQuestion | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const { question, header, options, multiSelect } = value as Record<string, unknown>;
  if (!nonEmpty(question) || !Array.isArray(options)) {
    return undefined;
  }
  const parsed = options.map(parseOption).filter((o): o is AgentQuestionOption => o !== undefined);
  if (parsed.length === 0) {
    return undefined; // a question with nothing to pick is prose, not a form
  }
  return {
    question,
    ...(nonEmpty(header) ? { header } : {}),
    multiSelect: multiSelect === true,
    options: parsed,
  };
}

/**
 * The questions inside an AskUserQuestion input, or inside the metadata
 * value that carried them; undefined when the shape is not one a client
 * could render, so the caller falls back to the prose.
 */
export function parseAgentQuestions(value: unknown): AgentQuestion[] | undefined {
  const list = Array.isArray(value)
    ? value
    : typeof value === "object" && value !== null
      ? (value as Record<string, unknown>).questions
      : undefined;
  if (!Array.isArray(list) || list.length === 0) {
    return undefined;
  }
  const questions = list.map(parseQuestion).filter((q): q is AgentQuestion => q !== undefined);
  return questions.length === list.length ? questions : undefined;
}
