import type { CardStep } from "./state.js";

/**
 * The turn card: one Components V2 message per task, edited in place while
 * the agent works. A fixed shape — a container whose accent colour is the
 * state, a status line with the Stop button as its accessory, the steps,
 * the streamed answer — so the component cap is never in play and every
 * edit replaces the whole thing from one record.
 *
 * https://docs.discord.com/developers/components/reference
 */

export const IS_COMPONENTS_V2 = 1 << 15;
export const SUPPRESS_NOTIFICATIONS = 1 << 12;
export const EPHEMERAL = 1 << 6;

/** Displayable text per message across every component, as recorded. */
export const TEXT_LIMIT = 4_000;

/** Custom ids the bridge gives its own buttons; the engine routes taps by them. */
export const STOP_ID = "thicket:stop";

export type CardState = "working" | "waiting" | "completed" | "failed" | "cancelled" | "frozen";

const ACCENT: Record<CardState, number> = {
  working: 0x5865f2,
  waiting: 0xfee75c,
  completed: 0x57f287,
  failed: 0xed4245,
  cancelled: 0x99aab5,
  frozen: 0x5865f2,
};

const GLYPH: Record<CardStep["status"], string> = {
  running: "⏳",
  done: "✅",
  failed: "❌",
};

export interface CardView {
  state: CardState;
  status: string;
  steps: CardStep[];
  text: string;
}

/** The step lines as one Text Display's content. */
export function stepsText(steps: CardStep[]): string {
  return steps.map((step) => `${GLYPH[step.status]} ${step.title}`).join("\n");
}

/** The steps as Discord subtext (`-# …`): small and grey under a finished answer. */
function stepsFootnote(steps: CardStep[]): string {
  return steps.map((step) => `-# ${GLYPH[step.status]} ${step.title}`).join("\n");
}

/** How much answer text a card with this status and these steps can still hold. */
export function textBudget(status: string, steps: CardStep[]): number {
  return TEXT_LIMIT - status.length - stepsText(steps).length;
}

/** How many closed steps a rolled-over card carries forward. */
const CARRIED_CLOSED = 3;

/**
 * The steps a new card opens with after a rollover: everything still
 * running and the last few closed, so a tool-heavy turn cannot carry more
 * steps than the budget.
 */
export function carriedSteps(steps: CardStep[]): CardStep[] {
  const running = steps.filter((step) => step.status === "running");
  const closed = steps.filter((step) => step.status !== "running").slice(-CARRIED_CLOSED);
  return [...closed, ...running];
}

function textDisplay(content: string) {
  return { type: 10, content };
}

function separator() {
  return { type: 14, divider: true, spacing: 1 };
}

/**
 * The message body for a card in a given state. A Text Display may not be
 * empty, so the steps and answer displays exist only once they have
 * content. Stop is offered only while the turn can still be stopped.
 *
 * A completed turn sheds the card: the container, the status line and the
 * accent bar were the presentation of work in progress, and a finished
 * answer should read as a message. The steps stay, as subtext beneath it,
 * because they are the record of what was done. The other terminal states
 * keep the container: there the state is the point.
 */
export function renderCard(view: CardView): { flags: number; components: unknown[]; allowed_mentions: { parse: never[] } } {
  if (view.state === "completed") {
    const components: unknown[] = [];
    if (view.text !== "") {
      components.push(textDisplay(view.text));
    }
    if (view.steps.length > 0) {
      components.push(textDisplay(stepsFootnote(view.steps)));
    }
    if (components.length === 0) {
      components.push(textDisplay("-# Done, with nothing to say."));
    }
    return { flags: IS_COMPONENTS_V2, components, allowed_mentions: { parse: [] } };
  }
  const status = view.state === "frozen" ? `${view.status} · continued below` : view.status;
  const section =
    view.state === "working"
      ? {
          type: 9,
          components: [textDisplay(`**${status}**`)],
          accessory: { type: 2, style: 4, label: "Stop", custom_id: STOP_ID },
        }
      : textDisplay(`**${status}**`);
  const components: unknown[] = [section];
  const steps = stepsText(view.steps);
  if (steps !== "") {
    components.push(separator(), textDisplay(steps));
  }
  if (view.text !== "") {
    components.push(separator(), textDisplay(view.text));
  }
  return {
    flags: IS_COMPONENTS_V2,
    components: [{ type: 17, accent_color: ACCENT[view.state], components }],
    // Agent text can never ping a person, a role, or everyone.
    allowed_mentions: { parse: [] },
  };
}

/** The status line's words for each terminal state. */
export function terminalStatus(state: Exclude<CardState, "working" | "frozen">): string {
  switch (state) {
    case "completed":
      return "Done";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Stopped";
    case "waiting":
      return "Waiting for you";
  }
}
