export const packageName = "@thicket/roster";

export {
  parseRoster,
  validateRoster,
  RosterValidationError,
  type AgentEntry,
  type AgentHarness,
  type AgentPhone,
  type AgentSkillEntry,
  type Roster,
} from "./schema.js";
export {
  toAgentCard,
  agentUrl,
  nodeName,
  A2A_PATH,
  A2A_PROTOCOL_VERSION,
  TAILNET_PEER_TAG_SCHEME,
  type CardOptions,
} from "./card.js";
export { cacheDir, configDir, stateDir, runtimeDir, socketPath } from "./paths.js";
export { phoneEnabledAgents, type PhoneAgent } from "./phone.js";
