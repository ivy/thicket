import { packageName as rosterPackageName } from "@thicket/roster";

export const packageName = "@thicket/agentd";
export const rosterDependency = rosterPackageName;

export { SqliteTaskStore, TERMINAL_STATES } from "./store/sqlite-task-store.js";
export { JournalStore, type JournalEntry, type CostSummary } from "./store/journal.js";
export { runMigrations, CURRENT_SCHEMA_VERSION } from "./store/migrations.js";
export { buildServer, parsePeerTags, PEER_TAGS_HEADER } from "./server.js";
export { resolveListenTarget, listen, assertNotWorldAccessible } from "./listen.js";
export { loadConfig, sessionEnv, defaultConfigPath, type AgentdConfig } from "./config.js";
export { createLogger, type Logger } from "./logger.js";
export { run } from "./main.js";
