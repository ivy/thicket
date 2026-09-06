import { randomUUID } from "node:crypto";

import type { HttpDoer } from "./http.js";

export interface AskResult {
  taskId: string;
  contextId: string;
  state: string;
  text: string;
}

export interface SendOptions {
  text: string;
  /** Absent starts a fresh conversation. */
  contextId?: string;
  /** What the message id starts with; says which caller minted it. */
  messageIdPrefix?: string;
  metadata?: Record<string, unknown>;
  /** Return once the task exists rather than when the turn ends. */
  returnImmediately?: boolean;
  timeoutMs?: number;
}

interface JsonRpcEnvelope {
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

function textFromParts(parts: unknown): string {
  if (!Array.isArray(parts)) {
    return "";
  }
  return parts
    .map((part) => {
      const p = part as { text?: string };
      return typeof p.text === "string" ? p.text : "";
    })
    .join("");
}

/** Final human-readable text of a proto-JSON Task. */
export function taskText(task: Record<string, unknown>): string {
  const status = (task.status ?? {}) as { message?: { parts?: unknown } };
  const fromStatus = textFromParts(status.message?.parts);
  if (fromStatus !== "") {
    return fromStatus;
  }
  const artifacts = (task.artifacts ?? []) as { parts?: unknown }[];
  return artifacts.map((artifact) => textFromParts(artifact.parts)).join("");
}

/**
 * Minimal A2A JSON-RPC client over an HttpDoer. Errors distinguish
 * authorization rejections (agentd's 403 envelope) from unreachability so
 * the operator sees the actual problem, not a timeout.
 */
export class A2aJsonRpcClient {
  constructor(
    private readonly http: HttpDoer,
    private readonly rpcUrl: string,
  ) {}

  private async call(
    method: string,
    params: unknown,
    timeoutMs?: number,
  ): Promise<Record<string, unknown>> {
    let response;
    try {
      response = await this.http({
        method: "POST",
        url: this.rpcUrl,
        headers: {
          "content-type": "application/json",
          "a2a-version": "1.0",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method, params }),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      });
    } catch (err) {
      throw new Error(
        `agent unreachable at ${this.rpcUrl}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    let envelope: JsonRpcEnvelope;
    try {
      envelope = JSON.parse(response.body) as JsonRpcEnvelope;
    } catch {
      throw new Error(`agent returned HTTP ${response.status} with a non-JSON body`);
    }
    if (envelope.error !== undefined) {
      if (response.status === 403) {
        throw new Error(`not authorized: ${envelope.error.message}`);
      }
      throw new Error(`A2A error ${envelope.error.code}: ${envelope.error.message}`);
    }
    if (envelope.result === undefined) {
      throw new Error(`agent returned HTTP ${response.status} with no result`);
    }
    return envelope.result;
  }

  async ask(message: string, contextId?: string): Promise<AskResult> {
    return this.send({ text: message, ...(contextId === undefined ? {} : { contextId }) });
  }

  /**
   * One SendMessage. `returnImmediately` is the protocol's own flag for a
   * caller that wants the task's coordinates rather than its outcome; the
   * result then describes a task still running. `metadata` rides on the
   * message for the executor to read.
   */
  async send(options: SendOptions): Promise<AskResult> {
    const effectiveContext = options.contextId ?? randomUUID();
    const prefix = options.messageIdPrefix ?? "mcp";
    const result = await this.call(
      "SendMessage",
      {
        tenant: "",
        message: {
          messageId: `${prefix}-${randomUUID()}`,
          contextId: effectiveContext,
          taskId: "",
          role: "ROLE_USER",
          parts: [{ text: options.text, mediaType: "text/plain", filename: "" }],
          metadata: options.metadata ?? {},
          extensions: [],
          referenceTaskIds: [],
        },
        ...(options.returnImmediately === true ? { configuration: { returnImmediately: true } } : {}),
      },
      options.timeoutMs,
    );
    const task = (result.task ?? result) as Record<string, unknown>;
    const status = (task.status ?? {}) as { state?: string };
    return {
      taskId: String(task.id ?? ""),
      contextId: String(task.contextId ?? effectiveContext),
      state: String(status.state ?? "TASK_STATE_UNSPECIFIED"),
      text: taskText(task),
    };
  }

  /** Tasks in a given state, newest first. stateName is the proto enum name. */
  async listTasks(stateName: string, pageSize = 20): Promise<Record<string, unknown>[]> {
    const result = await this.call("ListTasks", {
      tenant: "",
      contextId: "",
      status: stateName,
      pageToken: "",
      pageSize,
    });
    return (result.tasks ?? []) as Record<string, unknown>[];
  }

  async taskStatus(taskId: string): Promise<AskResult> {
    const task = await this.call("GetTask", { tenant: "", id: taskId });
    const status = (task.status ?? {}) as { state?: string };
    return {
      taskId: String(task.id ?? taskId),
      contextId: String(task.contextId ?? ""),
      state: String(status.state ?? "TASK_STATE_UNSPECIFIED"),
      text: taskText(task),
    };
  }
}
