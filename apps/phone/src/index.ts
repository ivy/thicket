export const packageName = "@thicket/phone";

export { loadPhoneConfig, parsePhoneConfig, PhoneConfigError, type PhoneConfig } from "./config.js";
export {
  decodeInbound,
  encodeOutbound,
  endSession,
  playDigits,
  playMedia,
  RelayCodecError,
  say,
  type CallEvent,
  type RelayCommand,
} from "./codec.js";
export {
  CallEngine,
  phoneMessageId,
  phoneSessionId,
  type AlertPort,
  type CallEngineOptions,
  type CallState,
  type Clock,
  type EngineLogger,
  type LockoutPort,
  type PhoneAlert,
  type RelayPort,
  type Scheduler,
} from "./engine.js";
export { MemoryPhoneState, type PhoneSession, type PhoneStatePort } from "./state.js";
export { CallRegistry, type CallRecord, type LockoutPolicy } from "./registry.js";
export { buildPhoneServer, RELAY_ATTRIBUTES, type PhoneServer, type PhoneServerOptions } from "./server.js";
export { signatureValid, twilioSignature } from "./signature.js";
export { maskNumber, pinVerifier, run } from "./main.js";
