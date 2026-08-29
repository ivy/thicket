export const packageName = "@thicket/bridge";

export { BridgeEngine, sessionTitle, slackStatusFor, type EngineOptions } from "./engine.js";
export { BridgeState, type InFlightTask, type QueuedRequest } from "./state.js";
export { ConnectionSupervisor, type Connection, type ConnectionFactory } from "./supervisor.js";
export { translateSlackEvent, translateSlackInteraction } from "./translate.js";
export {
  answerText,
  decodeAnswers,
  renderAnsweredBlocks,
  renderQuestionBlocks,
} from "./questions.js";
export { RemoteAgentClient, toA2AEvent } from "./a2a-client.js";
export { WebSlackApi } from "./slack-api.js";
export { SlackSocketConnection } from "./socket.js";
export {
  META_QUEUED_TURN_COUNT,
  META_SHOULD_QUERY,
  type A2AEvent,
  type AgentActivity,
  type AgentClient,
  type InboundEvent,
  type SlackApi,
  type SlackSessionStatus,
} from "./types.js";
export { run } from "./main.js";
