export const packageName = "@thicket/executor";

export {
  TurnTranslator,
  ASSISTANT_TEXT_ARTIFACT_ID,
  type TranslatorOptions,
} from "./translator.js";
export {
  ClaudeAgentExecutor,
  messageText,
  type ClaudeAgentExecutorOptions,
} from "./executor.js";
export {
  META_CANCELLED,
  META_FOLDED_MESSAGE_IDS,
  META_QUEUED_TURN_COUNT,
  META_QUEUE_STATE,
  META_STILL_QUEUED,
  type PendingSend,
  type SessionHandle,
  type SessionProvider,
} from "./types.js";
