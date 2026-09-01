import { randomUUID } from "node:crypto";

import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { Role, TaskState } from "@a2a-js/sdk";
import type { Message } from "@a2a-js/sdk";
import { AgentEvent } from "@a2a-js/sdk/server";
import type {
  AgentExecutionEvent,
  AgentExecutor,
  ExecutionEventBus,
  RequestContext,
} from "@a2a-js/sdk/server";

import {
  attachmentPreamble,
  attachmentRefs,
  type AttachmentStore,
  type StoredAttachment,
} from "./attachments.js";
import { UnknownWorkspaceError } from "./session-manager.js";
import { TurnTranslator, type TurnAccounting } from "./translator.js";
import {
  META_CANCELLED,
  META_CONTEXT_ONLY,
  META_PRIORITY,
  META_QUEUE_STATE,
  META_SHOULD_QUERY,
  META_PHONE_CALL,
  META_PHONE_KIND,
  META_PHONE_SESSION_STARTED,
  META_SLACK_CHANNEL,
  META_SLACK_THREAD,
  META_STILL_QUEUED,
  META_WORKSPACE,
  type SessionHandle,
  type SessionProvider,
} from "./types.js";

export interface ClaudeAgentExecutorOptions {
  sessions: SessionProvider;
  /** Injectable uuid source for deterministic tests. */
  uuid?: () => string;
  /** Injectable clock for deterministic tests. */
  now?: () => string;
  onWarning?: (message: string) => void;
  /**
   * Where referred-to files are materialized. Absent means this agent
   * refuses attachments, per its roster policy.
   */
  attachments?: AttachmentStore;
  /** Per-turn accounting sink (the journal, task 025). */
  onTurnResult?: (record: TurnAccounting) => void;
}

interface ContextState {
  session: SessionHandle;
  translator: TurnTranslator;
  pump: Promise<void>;
}

/** Extracts the concatenated text content of an A2A message. */
export function messageText(message: Message): string {
  return message.parts
    .map((part) => (part.content?.$case === "text" ? part.content.value : ""))
    .join("");
}

/**
 * One line saying where the conversation is, when it is in Slack. The reply
 * reaches the thread by itself, so the ids are not an invitation to post or
 * read there — they are for the tools that have to name a place, upload_file
 * above all. A message from anywhere else — local Claude Code over MCP, a
 * schedule — carries no coordinates and gets no line.
 */
export function threadPreamble(inbound: Message): string {
  const channel = inbound.metadata?.[META_SLACK_CHANNEL];
  const thread = inbound.metadata?.[META_SLACK_THREAD];
  if (typeof channel !== "string" || channel === "" || typeof thread !== "string" || thread === "") {
    return "";
  }
  return (
    `You are in Slack channel ${channel}, thread ${thread}. Your reply reaches ` +
    `that thread on its own — no tool sends it. The ids are for the thicket ` +
    `tools that must name a place: uploading a file here, or reaching a ` +
    `conversation you are not answering in.\n\n`
  );
}

/**
 * The line that tells the model it is on a voice call. Only the fact of the
 * call, who is on it, how long, and that the reply will be spoken: the
 * call identifier and the numbers stay in metadata for the bridge, never
 * in the prompt, so no tool can be talked into a call the model names.
 * Digits, events, and interruptions get a sentence saying what the message
 * is, since none of them read like speech.
 */
export function phonePreamble(inbound: Message, now: () => string = () => new Date().toISOString()): string {
  const call = inbound.metadata?.[META_PHONE_CALL];
  if (typeof call !== "string" || call === "") {
    return "";
  }
  const started = inbound.metadata?.[META_PHONE_SESSION_STARTED];
  const startedMs = typeof started === "string" ? Date.parse(started) : Number.NaN;
  const elapsed = Number.isNaN(startedMs) ? undefined : Math.max(0, Date.parse(now()) - startedMs);
  const running =
    elapsed === undefined
      ? ""
      : elapsed < 60_000
        ? " The session began under a minute ago."
        : ` The session has run ${Math.round(elapsed / 60_000)} minutes.`;
  const kind = inbound.metadata?.[META_PHONE_KIND];
  const what =
    kind === "dtmf"
      ? " This message is digits the operator keyed, not speech."
      : kind === "event"
        ? " This message is an event from the call, not the operator's words."
        : kind === "interrupted"
          ? " The operator spoke over your previous reply; this message is what they said."
          : "";
  return (
    `You are on a voice call with the operator, who authenticated with their PIN.${running} ` +
    `Your reply will be read aloud by text-to-speech: keep it short and speakable — ` +
    `no markdown, code, tables, or lists — and spell out anything that must be exact.${what}\n\n`
  );
}

/**
 * A2A AgentExecutor over a Claude Code session. Translation itself lives
 * in {@link TurnTranslator}; this class owns send stamping, event routing
 * to the right task's bus, and cancellation via interrupt.
 */
export class ClaudeAgentExecutor implements AgentExecutor {
  private readonly sessions: SessionProvider;
  private readonly uuid: () => string;
  private readonly now: () => string;
  private readonly onWarning: (message: string) => void;
  private readonly attachments: AttachmentStore | undefined;
  private readonly onTurnResult: ((record: TurnAccounting) => void) | undefined;

  private readonly contexts = new Map<string, ContextState>();
  private readonly busByTask = new Map<string, ExecutionEventBus>();
  private readonly contextOfTask = new Map<string, string>();

  constructor(options: ClaudeAgentExecutorOptions) {
    this.sessions = options.sessions;
    this.uuid = options.uuid ?? (() => randomUUID());
    this.now = options.now ?? (() => new Date().toISOString());
    this.onWarning = options.onWarning ?? (() => {});
    this.attachments = options.attachments;
    this.onTurnResult = options.onTurnResult;
  }

  async execute(requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const { taskId, contextId } = requestContext;
    const inbound = requestContext.userMessage;
    const rawWorkspace = inbound.metadata?.[META_WORKSPACE];
    const workspace = typeof rawWorkspace === "string" && rawWorkspace !== "" ? rawWorkspace : undefined;
    let state: ContextState;
    try {
      state = await this.contextState(contextId, workspace);
    } catch (err) {
      if (!(err instanceof UnknownWorkspaceError)) {
        throw err;
      }
      // A bound channel naming a workspace this agent does not declare:
      // refuse out loud rather than run somewhere else. Silence, or $HOME,
      // would both look like an answer.
      this.onWarning(`turn refused: ${err.message}`);
      this.publishRefusal(eventBus, taskId, contextId, inbound, err.message);
      return;
    }

    const uuid = this.uuid();
    const contextOnly = inbound.metadata?.[META_SHOULD_QUERY] === false;
    const rawPriority = inbound.metadata?.[META_PRIORITY];
    const priority =
      rawPriority === "now" || rawPriority === "next" || rawPriority === "later"
        ? rawPriority
        : undefined;

    const sdkMessage: SDKUserMessage = {
      type: "user",
      message: { role: "user", content: (await this.preamble(contextId, inbound)) + messageText(inbound) },
      parent_tool_use_id: null,
      uuid: uuid as SDKUserMessage["uuid"],
      ...(contextOnly ? { shouldQuery: false as const } : {}),
      ...(priority !== undefined ? { priority } : {}),
    };

    if (contextOnly) {
      // The message merges into the next querying turn; no turn answers it,
      // so no send is registered. The caller still gets a well-formed,
      // immediately-completed task instead of a hang.
      await state.session.send(sdkMessage);
      eventBus.publish(
        AgentEvent.task({
          id: taskId,
          contextId,
          status: {
            state: TaskState.TASK_STATE_COMPLETED,
            message: undefined,
            timestamp: this.now(),
          },
          artifacts: [],
          history: [inbound],
          metadata: { [META_CONTEXT_ONLY]: true },
        }),
      );
      return;
    }

    this.busByTask.set(taskId, eventBus);
    this.contextOfTask.set(taskId, contextId);

    const done = state.translator.registerSend({
      uuid,
      messageId: inbound.messageId,
      taskId,
      contextId,
      message: inbound,
    });

    await state.session.send(sdkMessage);
    try {
      await done;
    } finally {
      this.busByTask.delete(taskId);
    }
  }

  /**
   * Attachments are fetched eagerly: a file the user attached is a file
   * they expect used, so making the model spend a tool call to discover it
   * buys nothing. A failure here is described rather than raised — the
   * question in the message is usually still answerable.
   */
  private async preamble(contextId: string, inbound: Message): Promise<string> {
    return (
      threadPreamble(inbound) +
      phonePreamble(inbound, this.now) +
      (await this.attachmentsPreamble(contextId, inbound))
    );
  }

  private async attachmentsPreamble(contextId: string, inbound: Message): Promise<string> {
    const refs = attachmentRefs(inbound);
    if (refs.length === 0) {
      return "";
    }
    if (this.attachments === undefined) {
      return attachmentPreamble(
        [],
        refs.map((ref) => ({
          filename: ref.filename,
          reason: "this agent does not accept attachments",
        })),
      );
    }
    const stored: StoredAttachment[] = [];
    const failures: { filename: string; reason: string }[] = [];
    for (const ref of refs) {
      try {
        stored.push(await this.attachments.store(contextId, ref));
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        this.onWarning(`attachment ${ref.filename} could not be retrieved: ${reason}`);
        failures.push({ filename: ref.filename, reason });
      }
    }
    return attachmentPreamble(stored, failures);
  }

  async cancelTask(taskId: string, eventBus: ExecutionEventBus): Promise<void> {
    const contextId = this.contextOfTask.get(taskId);
    const state = contextId !== undefined ? this.contexts.get(contextId) : undefined;
    if (contextId === undefined || state === undefined) {
      this.onWarning(`cancelTask: unknown task ${taskId}`);
      eventBus.publish(this.canceledStatus(taskId, "", { [META_QUEUE_STATE]: "unknown" }));
      return;
    }

    state.translator.markCancelRequested(taskId);
    const supportsCancelQueued =
      state.translator.capabilities?.includes("interrupt_cancel_queued_v1") ?? false;
    const receipt = await state.session.interrupt({ cancelQueued: supportsCancelQueued });

    // Honest queue reporting: without interrupt_cancel_queued_v1 the
    // queued sends survive the interrupt and WILL run; say so instead of
    // claiming everything stopped. Without interrupt_receipt_v1 there is
    // no receipt at all and the queue state is unknown.
    const metadata: Record<string, unknown> =
      receipt === undefined
        ? { [META_QUEUE_STATE]: "unknown" }
        : {
            [META_QUEUE_STATE]: supportsCancelQueued ? "queued-cancelled" : "queued-survives",
            [META_STILL_QUEUED]: receipt.still_queued,
            [META_CANCELLED]: receipt.cancelled ?? [],
          };

    eventBus.publish(this.canceledStatus(taskId, contextId, metadata));
    state.translator.markTerminalEmitted(taskId);
  }

  /** A task that never ran: it exists, and it says why it stopped. */
  private publishRefusal(
    eventBus: ExecutionEventBus,
    taskId: string,
    contextId: string,
    inbound: Message,
    reason: string,
  ): void {
    const message: Message = {
      messageId: `${taskId}-refused`,
      contextId,
      taskId,
      role: Role.ROLE_AGENT,
      parts: [
        {
          content: {
            $case: "text",
            value:
              `I can't take this one: this channel is bound to a workspace I don't have — ` +
              `${reason}. Fix the roster (agents.yaml) and try again.`,
          },
          mediaType: "text/plain",
          filename: "",
          metadata: {},
        },
      ],
      metadata: {},
      extensions: [],
      referenceTaskIds: [],
    };
    const now = this.now();
    eventBus.publish(
      AgentEvent.task({
        id: taskId,
        contextId,
        status: { state: TaskState.TASK_STATE_WORKING, message: undefined, timestamp: now },
        artifacts: [],
        history: [inbound],
        metadata: {},
      }),
    );
    eventBus.publish(
      AgentEvent.statusUpdate({
        taskId,
        contextId,
        status: { state: TaskState.TASK_STATE_FAILED, message, timestamp: now },
        metadata: {},
      }),
    );
  }

  private canceledStatus(
    taskId: string,
    contextId: string,
    metadata: Record<string, unknown>,
  ): AgentExecutionEvent {
    return AgentEvent.statusUpdate({
      taskId,
      contextId,
      status: {
        state: TaskState.TASK_STATE_CANCELED,
        message: {
          messageId: `${taskId}-canceled`,
          contextId,
          taskId,
          role: Role.ROLE_AGENT,
          parts: [
            {
              content: { $case: "text", value: "task canceled" },
              mediaType: "text/plain",
              filename: "",
              metadata: {},
            },
          ],
          metadata: {},
          extensions: [],
          referenceTaskIds: [],
        },
        timestamp: this.now(),
      },
      metadata,
    });
  }

  private async contextState(contextId: string, workspace?: string): Promise<ContextState> {
    // Asked every turn, not once: a channel bound after the thread began
    // moves the session on its next turn, and an unknown name fails now.
    const session = await this.sessions.sessionFor(
      contextId,
      workspace === undefined ? {} : { workspace },
    );
    const existing = this.contexts.get(contextId);
    if (existing !== undefined) {
      return existing;
    }
    const translator = new TurnTranslator({
      publish: (event) => this.route(event),
      now: this.now,
      onWarning: this.onWarning,
      ...(this.onTurnResult === undefined ? {} : { onTurnResult: this.onTurnResult }),
    });
    const pump = (async () => {
      try {
        for await (const frame of session.frames) {
          translator.handleFrame(frame);
        }
        translator.endStream();
      } catch (err) {
        translator.endStream(
          `session stream failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    })();
    const state: ContextState = { session, translator, pump };
    this.contexts.set(contextId, state);
    return state;
  }

  private route(event: AgentExecutionEvent): void {
    const taskId = event.kind === "task" ? event.data.id : event.kind === "message" ? undefined : event.data.taskId;
    const bus = taskId !== undefined ? this.busByTask.get(taskId) : undefined;
    if (bus !== undefined) {
      bus.publish(event);
      return;
    }
    // Events for a task whose execute() call already returned (or whose
    // send was folded into another task) have no live bus; the wiring
    // daemon (task 008) can install a default sink per context if needed.
    this.onWarning(`no live bus for event on task ${taskId ?? "<none>"}; dropped`);
  }
}
