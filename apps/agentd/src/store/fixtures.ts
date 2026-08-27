import { Role, Task, TaskState, taskStateToJSON } from "@a2a-js/sdk";
import { ServerCallContext } from "@a2a-js/sdk/server";
import type { User } from "@a2a-js/sdk/server";

class TestUser implements User {
  constructor(private readonly name: string) {}
  get isAuthenticated(): boolean {
    return true;
  }
  get userName(): string {
    return this.name;
  }
}

export function makeContext(user = "tester", tenant?: string): ServerCallContext {
  return new ServerCallContext({ user: new TestUser(user), tenant });
}

export interface MakeTaskOptions {
  id: string;
  contextId?: string;
  state?: TaskState;
  timestamp?: string;
  withContent?: boolean;
}

/**
 * Builds a canonical Task (the shape Task.fromJSON produces) so that
 * store round-trips can be compared with deep equality.
 */
export function makeTask(options: MakeTaskOptions): Task {
  const {
    id,
    contextId = "ctx-default",
    state = TaskState.TASK_STATE_SUBMITTED,
    timestamp = "2026-08-01T10:00:00.000Z",
    withContent = false,
  } = options;
  const task: Task = {
    id,
    contextId,
    status: {
      state,
      message: undefined,
      timestamp,
    },
    artifacts: withContent
      ? [
          {
            artifactId: `${id}-artifact-1`,
            name: "result.txt",
            description: "primary output",
            parts: [
              {
                content: { $case: "text", value: `artifact for ${id}` },
                mediaType: "text/plain",
                filename: "result.txt",
                metadata: { origin: "test" },
              },
            ],
            metadata: { rank: "1" },
            extensions: [],
          },
        ]
      : [],
    history: withContent
      ? [
          {
            messageId: `${id}-msg-1`,
            contextId,
            taskId: id,
            role: Role.ROLE_USER,
            parts: [
              {
                content: { $case: "text", value: "do the thing" },
                mediaType: "text/plain",
                filename: "",
                metadata: {},
              },
            ],
            metadata: {},
            extensions: [],
            referenceTaskIds: [],
          },
          {
            messageId: `${id}-msg-2`,
            contextId,
            taskId: id,
            role: Role.ROLE_AGENT,
            parts: [
              {
                content: { $case: "text", value: "doing the thing" },
                mediaType: "text/plain",
                filename: "",
                metadata: {},
              },
            ],
            metadata: {},
            extensions: [],
            referenceTaskIds: [],
          },
        ]
      : [],
    metadata: withContent ? { source: "conformance" } : {},
  };
  // Canonicalize through the SDK codec so field presence matches what any
  // codec-based store returns.
  return Task.fromJSON(Task.toJSON(task));
}

export function stateName(state: TaskState): string {
  return taskStateToJSON(state);
}
