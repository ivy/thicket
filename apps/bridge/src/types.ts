import type { Message, Task, TaskState } from "@a2a-js/sdk";
import type { AgentActivity } from "@thicket/executor";

/**
 * An upload attached to a Slack message. `downloadUrl` is Slack-private:
 * it needs the bot token, so only the bridge can ever redeem it.
 */
export interface SlackFile {
  id: string;
  name: string;
  mimetype: string;
  size: number;
  downloadUrl: string;
}

interface MessageEvent {
  channel: string;
  threadTs: string;
  text: string;
  messageTs: string;
  files: SlackFile[];
}

/** Slack events the bridge acts on, already unwrapped from envelopes. */
export type InboundEvent =
  | ({ kind: "dm" } & MessageEvent)
  | ({ kind: "mention" } & MessageEvent)
  | ({ kind: "thread_message" } & MessageEvent)
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
    }
  | { kind: "activity"; taskId: string; activities: AgentActivity[] };

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
  setStatus(
    channel: string,
    threadTs: string,
    status: SlackSessionStatus,
    options?: { title?: string },
  ): Promise<void>;
  /** The line of prose under the app's name; "" clears it. */
  setThreadStatus(channel: string, threadTs: string, status: string): Promise<void>;
  postMessage(channel: string, threadTs: string, text: string): Promise<void>;
  /** chat.startStream → stream ts used for appends. */
  startStream(channel: string, threadTs: string): Promise<string>;
  appendStream(channel: string, streamTs: string, text: string): Promise<void>;
  /** A step the agent took, rendered as a card on the open stream. */
  appendActivity(channel: string, streamTs: string, activity: AgentActivity): Promise<void>;
  stopStream(channel: string, streamTs: string): Promise<void>;
}

// Metadata keys and the activity shape are thicket's A2A extension; the
// executor package owns their definitions so the two ends cannot drift.
export { META_QUEUED_TURN_COUNT, META_SHOULD_QUERY } from "@thicket/executor";
export type { AgentActivity } from "@thicket/executor";
