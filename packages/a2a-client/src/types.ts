import type { Message, Task, TaskState } from "@a2a-js/sdk";
import type { AgentActivity } from "@thicket/executor";

/** Normalized A2A stream event, transport-independent. */
export type A2AEvent =
  | { kind: "task"; task: Task }
  | {
      kind: "status";
      taskId: string;
      contextId: string;
      state: TaskState;
      messageText?: string;
      metadata?: Record<string, unknown>;
    }
  | {
      kind: "artifact";
      taskId: string;
      text: string;
      append: boolean;
      lastChunk: boolean;
    }
  | { kind: "activity"; taskId: string; activities: AgentActivity[] };

/**
 * The slice of an A2A agent a bridge uses. Implemented over the SDK
 * client in production; stubbed in tests. Every method may reject with a
 * connection error when the agent's machine is asleep.
 */
export interface AgentClient {
  /** Fetch the agent card; also the reachability probe. */
  fetchCard(): Promise<{ streaming: boolean }>;
  /** Streaming send; yields events until terminal. */
  stream(message: Message): AsyncIterable<A2AEvent>;
  /** Blocking send for non-streaming agents. */
  send(message: Message): Promise<Task>;
  cancel(taskId: string): Promise<void>;
  /** Reattach to a task from a previous bridge process. */
  resubscribe(taskId: string): AsyncIterable<A2AEvent>;
  /** The task as the agent holds it now — its state and what it produced. */
  getTask?(taskId: string): Promise<Task>;
}
