export const packageName = "@thicket/discord";

export { BridgeEngine, deriveContextId, type EngineOptions } from "./engine.js";
export { BridgeState, type CardRecord, type CardStep, type InFlightTask, type QueuedRequest } from "./state.js";
export { ConnectionSupervisor, type Connection, type ConnectionFactory } from "./supervisor.js";
export { AgentConnection } from "./connection.js";
export { GatewayConnection, BRIDGE_INTENTS, type GatewaySession, type SessionStore } from "./gateway.js";
export { DiscordRest, DiscordApiError, InvalidResponseBreaker, multipart } from "./rest.js";
export { RestDiscordApi, threadName } from "./discord-api.js";
export { CardEditor } from "./editor.js";
export { renderCard, STOP_ID, TEXT_LIMIT, type CardView } from "./card.js";
export { translateDispatch, translateInteraction, translateMessage } from "./translate.js";
export type { CardBody, ChannelInfo, DiscordApi, HistoryMessage, PlainMessage } from "./api.js";
export type { A2AEvent, AgentClient, EngineLogger, InboundEvent, MessageEvent } from "./types.js";
export { assertConfigured, run, type BridgeConfig } from "./main.js";
