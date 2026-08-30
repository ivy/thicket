export const packageName = "@thicket/executor";

export {
  TurnTranslator,
  ASSISTANT_TEXT_ARTIFACT_ID,
  type TranslatorOptions,
  type TurnAccounting,
} from "./translator.js";
export {
  ClaudeAgentExecutor,
  messageText,
  phonePreamble,
  threadPreamble,
  type ClaudeAgentExecutorOptions,
} from "./executor.js";
export {
  ACTIVITY_ARTIFACT_ID,
  ACTIVITY_MEDIA_TYPE,
  activity,
  describeToolUse,
  parseAgentActivity,
  ACTIVITY_ICONS,
  type AgentActivity,
  type AgentActivityIcon,
  type AgentActivityStatus,
  type ToolDescription,
} from "./activity.js";
export {
  META_QUESTIONS,
  parseAgentQuestions,
  type AgentQuestion,
  type AgentQuestionOption,
} from "./questions.js";
export {
  AttachmentStore,
  AttachmentTooLarge,
  attachmentPreamble,
  attachmentRefs,
  safeName,
  DEFAULT_MAX_ATTACHMENT_BYTES,
  META_FILE_SIZE,
  type AttachmentRef,
  type AttachmentStoreOptions,
  type StoredAttachment,
} from "./attachments.js";
export { deriveSessionId, uuidv5, THICKET_NAMESPACE } from "./session-id.js";
export { PushQueue } from "./push-queue.js";
export {
  QUESTION_TOOL,
  SessionManager,
  UnknownWorkspaceError,
  deferQuestion,
  denyUnanswerable,
  type QueryFn,
  type SessionManagerOptions,
} from "./session-manager.js";
export {
  META_CANCELLED,
  META_CONTEXT_ONLY,
  META_FOLDED_INTO,
  META_FOLDED_MESSAGE_IDS,
  META_PHONE_CALL,
  META_PHONE_DIRECTION,
  META_PHONE_FROM,
  META_PHONE_KIND,
  META_PHONE_SESSION_STARTED,
  META_PHONE_TO,
  META_PRIORITY,
  META_QUEUED_TURN_COUNT,
  META_QUEUE_STATE,
  META_SHOULD_QUERY,
  META_SLACK_CHANNEL,
  META_SLACK_THREAD,
  META_STILL_QUEUED,
  META_TRIGGER,
  META_WORKSPACE,
  PHONE_MESSAGE_KINDS,
  TRIGGER_PHONE,
  type PendingSend,
  type PhoneMessageKind,
  type SessionHandle,
  type SessionProvider,
} from "./types.js";
