import { randomUUID } from "node:crypto";

import type { HttpDoer } from "./http.js";

export interface AskResult {
  taskId: string;
  contextId: string;
  state: string;
  text: string;
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

  private async call(method: string, params: unknown): Promise<Record<string, unknown>> {
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
    const effectiveContext = contextId ?? randomUUID();
    const result = await this.call("SendMessage", {
      tenant: "",
      message: {
        messageId: `mcp-${randomUUID()}`,
        contextId: effectiveContext,
        taskId: "",
        role: "ROLE_USER",
        parts: [{ text: message, mediaType: "text/plain", filename: "" }],
        metadata: {},
        extensions: [],
        referenceTaskIds: [],
      },
    });
    const task = (result.task ?? result) as Record<string, unknown>;
    const status = (task.status ?? {}) as { state?: string };
    return {
      taskId: String(task.id ?? ""),
      contextId: String(task.contextId ?? effectiveContext),
      state: String(status.state ?? "TASK_STATE_UNSPECIFIED"),
      text: taskText(task),
    };
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
