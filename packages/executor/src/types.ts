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
