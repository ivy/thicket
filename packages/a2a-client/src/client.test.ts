import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";

import express from "express";
import { TaskState, type Message, type StreamResponse } from "@a2a-js/sdk";
import {
  AgentEvent,
  DefaultRequestHandler,
  InMemoryTaskStore,
  type AgentExecutor,
  type ExecutionEventBus,
  type RequestContext,
} from "@a2a-js/sdk/server";
import { agentCardHandler, jsonRpcHandler, UserBuilder } from "@a2a-js/sdk/server/express";
import { ACTIVITY_ARTIFACT_ID, ACTIVITY_MEDIA_TYPE } from "@thicket/executor";
import { A2A_PATH, toAgentCard, type AgentEntry } from "@thicket/roster";

import { RemoteAgentClient, toA2AEvent, type A2AEvent } from "./index.js";

// A scripted agent: replies "hello" to anything, and a message saying "hang"
// stays working until it is cancelled.
class ScriptedExecutor implements AgentExecutor {
  private readonly hanging = new Map<string, () => void>();
  cancelled: string[] = [];

  async execute(context: RequestContext, bus: ExecutionEventBus): Promise<void> {
    const { taskId, contextId, userMessage } = context;
    const now = new Date().toISOString();
    bus.publish(
      AgentEvent.task({
        id: taskId,
        contextId,
        status: { state: TaskState.TASK_STATE_WORKING, message: undefined, timestamp: now },
        artifacts: [],
        history: [userMessage],
        metadata: {},
      }),
    );
    bus.publish(
      AgentEvent.artifactUpdate({
        taskId,
        contextId,
        artifact: {
          artifactId: "reply",
          name: "",
          description: "",
          parts: [textPart("hello")],
          metadata: {},
          extensions: [],
        },
        append: false,
        lastChunk: false,
        metadata: {},
      }),
    );
    const text = userMessage.parts.map((p) => (p.content?.$case === "text" ? p.content.value : "")).join("");
    if (text === "hang") {
      // A real executor's execute() lasts as long as the turn; the request
      // handler treats its return as the end of the stream.
      await new Promise<void>((resolve) => this.hanging.set(taskId, resolve));
      return;
    }
    bus.publish(
      AgentEvent.statusUpdate({
        taskId,
        contextId,
        status: { state: TaskState.TASK_STATE_COMPLETED, message: undefined, timestamp: now },
        metadata: {},
      }),
    );
  }

  async cancelTask(taskId: string, bus: ExecutionEventBus): Promise<void> {
    this.cancelled.push(taskId);
    bus.publish(
      AgentEvent.statusUpdate({
        taskId,
        contextId: "",
        status: { state: TaskState.TASK_STATE_CANCELED, message: undefined, timestamp: new Date().toISOString() },
        metadata: {},
      }),
    );
    this.hanging.get(taskId)?.();
    this.hanging.delete(taskId);
  }
}

function textPart(text: string) {
  return { content: { $case: "text" as const, value: text }, mediaType: "text/plain", filename: "", metadata: {} };
}

const entry: AgentEntry = {
  host: "test",
  user: "echo",
  description: "A scripted agent.",
  tag: "tag:thicket-echo",
  skills: [],
  harness: {
    type: "claude-agent-sdk",
    cwd: "/tmp",
    model: "claude-opus-5",
    sessionTtlSeconds: 300,
    permissionMode: "auto",
    attachments: "accept",
  },
  context: "native",
  queueing: "harness",
  workspaces: {},
  channels: {},
  phone: { enabled: false, aliases: [], resumeWindowSeconds: 86_400 },
};

async function startAgent(): Promise<{ url: string; executor: ScriptedExecutor; server: Server }> {
  const executor = new ScriptedExecutor();
  const handler = new DefaultRequestHandler(toAgentCard("echo", entry), new InMemoryTaskStore(), executor);
  const app = express();
  app.use("/.well-known/agent-card.json", agentCardHandler({ agentCardProvider: handler }));
  app.use(A2A_PATH, express.json(), jsonRpcHandler({ requestHandler: handler, userBuilder: UserBuilder.noAuthentication }));
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("no address");
  }
  return { url: `http://127.0.0.1:${address.port}`, executor, server };
}

function userMessage(text: string, contextId: string): Message {
  return {
    messageId: `test-${text}`,
    contextId,
    taskId: "",
    role: 1,
    parts: [textPart(text)],
    metadata: {},
    extensions: [],
    referenceTaskIds: [],
  };
}

test("a consumer streams a message and cancels a task with only this package", async () => {
  const agent = await startAgent();
  try {
    const client = new RemoteAgentClient(agent.url);
    assert.deepEqual(await client.fetchCard(), { streaming: true });

    const events: A2AEvent[] = [];
    for await (const event of client.stream(userMessage("hi", "ctx-1"))) {
      events.push(event);
    }
    assert.deepEqual(
      events.map((e) => e.kind),
      ["task", "artifact", "status"],
    );
    assert.equal(events[1]!.kind === "artifact" && events[1]!.text, "hello");
    assert.equal(events[2]!.kind === "status" && events[2]!.state, TaskState.TASK_STATE_COMPLETED);
    const first = events[0]!.kind === "task" ? events[0]!.task.id : "";
    const fetched = await client.getTask(first);
    assert.equal(fetched.id, first);
    assert.equal(fetched.status?.state, TaskState.TASK_STATE_COMPLETED);

    // A hanging task: cancel once its first artifact arrives; the stream
    // must end on the canceled status the executor publishes.
    const seen: A2AEvent[] = [];
    let cancelled: Promise<void> | undefined;
    for await (const event of client.stream(userMessage("hang", "ctx-2"))) {
      seen.push(event);
      if (event.kind === "artifact" && cancelled === undefined) {
        cancelled = client.cancel(event.taskId);
      }
    }
    await cancelled;
    assert.equal(agent.executor.cancelled.length, 1);
    const last = seen[seen.length - 1]!;
    assert.equal(last.kind === "status" && last.state, TaskState.TASK_STATE_CANCELED);
  } finally {
    agent.server.close();
  }
});

test("toA2AEvent keeps activity artifacts apart from text and lifts status text", () => {
  const activity = toA2AEvent({
    payload: {
      $case: "artifactUpdate",
      value: {
        taskId: "t1",
        contextId: "c1",
        artifact: {
          artifactId: ACTIVITY_ARTIFACT_ID,
          name: "agent-activity",
          description: "",
          parts: [
            {
              content: {
                $case: "data",
                value: { kind: "tool_use", id: "a1", title: "Read", icon: "file", status: "done" },
              },
              mediaType: ACTIVITY_MEDIA_TYPE,
              filename: "",
              metadata: {},
            },
          ],
          metadata: {},
          extensions: [],
        },
        append: false,
        lastChunk: false,
        metadata: {},
      },
    },
  } as unknown as StreamResponse);
  assert.equal(activity?.kind, "activity");

  const status = toA2AEvent({
    payload: {
      $case: "statusUpdate",
      value: {
        taskId: "t1",
        contextId: "c1",
        status: {
          state: TaskState.TASK_STATE_INPUT_REQUIRED,
          message: { parts: [textPart("which one?")] },
          timestamp: "",
        },
        metadata: {},
      },
    },
  } as unknown as StreamResponse);
  assert.deepEqual(status, {
    kind: "status",
    taskId: "t1",
    contextId: "c1",
    state: TaskState.TASK_STATE_INPUT_REQUIRED,
    messageText: "which one?",
    metadata: {},
  });
});
