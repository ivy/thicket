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
  type PhoneAlert,
  type RelayPort,
  type Scheduler,
} from "./engine.js";
export { MemoryPhoneState, type PhoneSession, type PhoneStatePort } from "./state.js";
