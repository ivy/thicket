import type { Message, StreamResponse, Task } from "@a2a-js/sdk";
import {
  AgentCardResolver,
  ClientFactory,
  ClientFactoryOptions,
  JsonRpcTransportFactory,
  type Client,
} from "@a2a-js/sdk/client";

import type { A2AEvent, AgentClient } from "./types.js";

function artifactText(parts: { content?: { $case: string; value: unknown } }[]): string {
  return parts
    .map((part) => (part.content?.$case === "text" ? String(part.content.value) : ""))
    .join("");
}

/** Maps SDK stream responses onto the bridge's transport-free event type. */
export function toA2AEvent(response: StreamResponse): A2AEvent | undefined {
  const payload = response.payload;
  if (payload === undefined) {
    return undefined;
  }
  switch (payload.$case) {
    case "task":
      return { kind: "task", task: payload.value };
    case "statusUpdate": {
      const status = payload.value.status;
      if (status === undefined) {
        return undefined;
      }
      return {
        kind: "status",
        taskId: payload.value.taskId,
        contextId: payload.value.contextId,
        state: status.state,
        messageText:
          status.message !== undefined ? artifactText(status.message.parts) || undefined : undefined,
        metadata: payload.value.metadata,
      };
    }
    case "artifactUpdate": {
      const artifact = payload.value.artifact;
      return {
        kind: "artifact",
        taskId: payload.value.taskId,
        text: artifact === undefined ? "" : artifactText(artifact.parts),
        append: payload.value.append,
        lastChunk: payload.value.lastChunk,
      };
    }
    default:
      return undefined;
  }
}

/**
 * AgentClient over the SDK's JSON-RPC transport. fetchImpl is injectable
 * so outbound traffic can be routed through netd's egress proxy socket.
 */
export class RemoteAgentClient implements AgentClient {
  private readonly baseUrl: string;
  private readonly factory: ClientFactory;
  private readonly resolver = AgentCardResolver.default;
  private client: Client | null = null;

  constructor(baseUrl: string, fetchImpl: typeof fetch = fetch) {
    this.baseUrl = baseUrl;
    this.factory = new ClientFactory(
      ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
        transports: [new JsonRpcTransportFactory({ fetchImpl })],
      }),
    );
  }

  async fetchCard(): Promise<{ streaming: boolean }> {
    const card = await this.resolver.resolve(this.baseUrl);
    this.client = await this.factory.createFromAgentCard(card);
    return { streaming: card.capabilities?.streaming === true };
  }

  private async connected(): Promise<Client> {
    if (this.client === null) {
      await this.fetchCard();
    }
    return this.client!;
  }

  async *stream(message: Message): AsyncIterable<A2AEvent> {
    const client = await this.connected();
    for await (const response of client.sendMessageStream({
      tenant: "",
      message,
      configuration: undefined,
      metadata: undefined,
    })) {
      const event = toA2AEvent(response as StreamResponse);
      if (event !== undefined) {
        yield event;
      }
    }
  }

  async send(message: Message): Promise<Task> {
    const client = await this.connected();
    const result = await client.sendMessage({
      tenant: "",
      message,
      configuration: undefined,
      metadata: undefined,
    });
    if ("messageId" in result) {
      throw new Error("agent replied with a bare message; expected a task");
    }
    return result as Task;
  }

  async cancel(taskId: string): Promise<void> {
    const client = await this.connected();
    await client.cancelTask({ tenant: "", id: taskId, metadata: undefined });
  }

  async *resubscribe(taskId: string): AsyncIterable<A2AEvent> {
    const client = await this.connected();
    for await (const response of client.resubscribeTask({ tenant: "", id: taskId })) {
      const event = toA2AEvent(response as StreamResponse);
      if (event !== undefined) {
        yield event;
      }
    }
  }
}
