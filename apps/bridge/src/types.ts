import type { Message, Task, TaskState } from "@a2a-js/sdk";

/** Slack events the bridge acts on, already unwrapped from envelopes. */
export type InboundEvent =
  | {
      kind: "dm";
      channel: string;
      threadTs: string;
      text: string;
      messageTs: string;
    }
  | {
      kind: "mention";
      channel: string;
      threadTs: string;
      text: string;
      messageTs: string;
    }
  | {
      kind: "thread_message";
      channel: string;
      threadTs: string;
      text: string;
      messageTs: string;
    }
  | {
      kind: "session_stopped";
      channel: string;
      threadTs: string;
    };

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
    };

/**
 * The slice of an A2A agent the bridge uses. Implemented over the SDK
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
}

export type SlackSessionStatus = "processing" | "active" | "suspended";

/** The Slack surface the bridge writes to. Stubbed in tests. */
export interface SlackApi {
  setStatus(channel: string, threadTs: string, status: SlackSessionStatus): Promise<void>;
  postMessage(channel: string, threadTs: string, text: string): Promise<void>;
  /** chat.startStream → stream ts used for appends. */
  startStream(channel: string, threadTs: string): Promise<string>;
  appendStream(channel: string, streamTs: string, text: string): Promise<void>;
  stopStream(channel: string, streamTs: string): Promise<void>;
}

/** Message metadata key: agent-side should append without triggering a turn. */
export const META_SHOULD_QUERY = "thicket.shouldQuery";
/** Terminal status metadata key set by the executor (task 005). */
export const META_QUEUED_TURN_COUNT = "queued_turn_count";
