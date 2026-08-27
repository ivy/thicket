import type { AgentCard, AgentSkill } from "@a2a-js/sdk";

import type { AgentEntry } from "./schema.js";

/** Name of the security scheme entry describing tailnet peer-tag authorization. */
export const TAILNET_PEER_TAG_SCHEME = "tailnet-peer-tag";

export const A2A_PROTOCOL_VERSION = "1.0";
export const A2A_PATH = "/a2a/v1";

export interface CardOptions {
  /** Card version; defaults to "0.1.0" until the roster carries versions. */
  version?: string;
  /**
   * Tailnet DNS suffix (e.g. "example.ts.net"). When set, interface URLs are
   * fully qualified; otherwise they use the bare MagicDNS host name.
   */
  tailnetDomain?: string;
}

/** Tailnet node name for an agent: its ACL tag without the "tag:" prefix. */
export function nodeName(entry: AgentEntry): string {
  return entry.tag.slice("tag:".length);
}

/** Base URL where the agent's A2A interface is served on the tailnet. */
export function agentUrl(entry: AgentEntry, options: CardOptions = {}): string {
  const host = options.tailnetDomain
    ? `${nodeName(entry)}.${options.tailnetDomain}`
    : nodeName(entry);
  return `https://${host}${A2A_PATH}`;
}

/** Derive the A2A AgentCard for one roster entry. */
export function toAgentCard(
  name: string,
  entry: AgentEntry,
  options: CardOptions = {},
): AgentCard {
  const skills: AgentSkill[] = entry.skills.map((skill) => ({
    id: skill.id,
    name: skill.name,
    description: skill.description,
    tags: skill.tags,
    examples: skill.examples,
    inputModes: [],
    outputModes: [],
    securityRequirements: [],
  }));

  return {
    name,
    description: entry.description,
    version: options.version ?? "0.1.0",
    supportedInterfaces: [
      {
        url: agentUrl(entry, options),
        protocolBinding: "JSONRPC",
        tenant: "",
        protocolVersion: A2A_PROTOCOL_VERSION,
      },
    ],
    provider: undefined,
    documentationUrl: undefined,
    capabilities: {
      // The claude-agent-sdk harness streams; it is the only harness type.
      streaming: entry.harness.type === "claude-agent-sdk",
      pushNotifications: false,
      extensions: [],
      extendedAgentCard: false,
    },
    securitySchemes: {
      [TAILNET_PEER_TAG_SCHEME]: {
        scheme: {
          $case: "mtlsSecurityScheme",
          value: {
            description:
              "Caller identity is the tailnet peer identity verified by netd " +
              "(WhoIs); authorization requires the ACL tags listed in " +
              "securityRequirements.",
          },
        },
      },
    },
    securityRequirements: [
      {
        schemes: {
          [TAILNET_PEER_TAG_SCHEME]: { list: [entry.tag] },
        },
      },
    ],
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills,
    signatures: [],
    iconUrl: undefined,
  };
}
