import type {
  SDKControlInterruptResponse,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { Message } from "@a2a-js/sdk";

/**
 * The slice of a live Claude Code session this package needs. Task 006
 * implements it over a real subprocess; tests implement it over recorded
 * frames. This package never spawns anything.
 */
export interface SessionHandle {
  /** The session's output frames, in emission order. */
  frames: AsyncIterable<SDKMessage>;
  /** Queue one user message into the session. */
  send(message: SDKUserMessage): void | Promise<void>;
  /**
   * Interrupt the running turn. cancelQueued maps to the control request's
   * cancel_queued field; pass it only when the CLI advertises
   * interrupt_cancel_queued_v1 (older CLIs ignore it and leave queued work
   * running).
   */
  interrupt(options?: {
    cancelQueued?: boolean;
  }): Promise<SDKControlInterruptResponse | undefined>;
}

/** Hands out the session bound to an A2A contextId. Implemented by task 006. */
export interface SessionProvider {
  sessionFor(contextId: string): SessionHandle | Promise<SessionHandle>;
}

/** One outbound send awaiting its turn. */
export interface PendingSend {
  /** Client uuid stamped on the SDKUserMessage; echoed as user_message_uuid. */
  uuid: string;
  /** A2A id of the inbound message that caused this send. */
  messageId: string;
  /** Task id the turn claims when this send is its primary. */
  taskId: string;
  contextId: string;
  /** The inbound A2A message, recorded in the task's history. */
  message?: Message;
}

/** Metadata keys stamped on emitted A2A events. */
export const META_QUEUED_TURN_COUNT = "queued_turn_count";
export const META_FOLDED_MESSAGE_IDS = "folded_message_ids";
export const META_STILL_QUEUED = "still_queued";
export const META_CANCELLED = "cancelled";
export const META_QUEUE_STATE = "queue_state";

// Inbound A2A message metadata: thicket's extensions to the protocol.
// The bridge writes these; the executor is the reader. One definition —
// the bridge imports them from here.
/** false = append to the transcript without triggering a turn. */
export const META_SHOULD_QUERY = "thicket.shouldQuery";
/** Maps onto SDKUserMessage.priority: "now" | "next" | "later". */
export const META_PRIORITY = "thicket.priority";
/** What caused the turn: absent means a human ("human"); routines and
 * delegation stamp their own values, and the journal records it. */
export const META_TRIGGER = "thicket.trigger";
/** Stamped on the synthetic task acknowledging a context-only message. */
export const META_CONTEXT_ONLY = "thicket.contextOnly";
/**
 * On the acknowledgment task of a send that was coalesced into another
 * send's turn: the task id that actually carries the answer.
 */
export const META_FOLDED_INTO = "thicket.foldedInto";
