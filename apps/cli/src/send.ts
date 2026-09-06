import { LOCAL_USER_HEADER } from "@thicket/agentd";
import { META_SENDER, META_TRIGGER, META_UNATTENDED, TRIGGER_SEND } from "@thicket/executor";
import { agentUrl, type Roster } from "@thicket/roster";

import { A2aJsonRpcClient } from "./mcp/a2a.js";
import { unixSocketHttp, type HttpDoer } from "./mcp/http.js";

/** Exit codes: a script reads these, so they are the contract. */
export const SEND_EXIT = {
  /** Accepted (fire-and-forget) or completed (`--wait`). */
  ok: 0,
  /** The agent took the message and the turn ended in any state but completed. */
  failed: 1,
  usage: 2,
  /** The message never reached the agent: unknown, unreachable, or refused. */
  undelivered: 3,
} as const;

export interface SendArgs {
  agent: string;
  /** Absent means read stdin. */
  message?: string;
  /** Block until the turn ends and print the reply; otherwise exit on acceptance. */
  wait: boolean;
  /** Continue an existing conversation; absent starts a fresh one. */
  contextId?: string;
}

/** Undefined means the arguments were not usable; the caller prints usage. */
export function parseSendArgs(args: string[]): SendArgs | undefined {
  let wait = false;
  let contextId: string | undefined;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--wait") {
      wait = true;
    } else if (arg === "--context") {
      contextId = args[i + 1];
      if (contextId === undefined || contextId === "") {
        return undefined;
      }
      i += 1;
    } else if (arg.startsWith("--")) {
      return undefined;
    } else {
      positional.push(arg);
    }
  }
  const [agent, message, extra] = positional;
  if (agent === undefined || agent === "" || extra !== undefined) {
    return undefined;
  }
  return {
    agent,
    wait,
    ...(message === undefined || message === "-" ? {} : { message }),
    ...(contextId === undefined ? {} : { contextId }),
  };
}

/**
 * How a message reaches the agent. Same account, same host: agentd's own
 * socket, the caller naming itself. Anyone else: this account's netd egress
 * and the tailnet, exactly the route `thicket mcp` takes, carrying whatever
 * tag this account's netd holds — and bounded by the same ACL.
 */
export type SendRoute =
  | { kind: "local"; socketPath: string }
  | { kind: "peer"; rpcUrl: string };

export interface SendDeps {
  roster: Roster;
  /** The agent this account runs, if it runs one, and where it listens. */
  local?: { agent: string; socketPath: string };
  /** The unix user running the command; what the local route presents. */
  localUser: string;
  /** The way off this account for the peer route; absent means there is none. */
  peerHttp?: HttpDoer;
  tailnetDomain?: string;
  /** Per-agent base-URL overrides, as the MCP server and fleet honour. */
  endpointOverrides?: Record<string, string>;
  out: (line: string) => void;
  err: (line: string) => void;
}

export function resolveRoute(deps: SendDeps, agent: string): SendRoute {
  const entry = deps.roster.agents[agent];
  if (entry === undefined) {
    throw new Error(
      `unknown agent "${agent}"; roster has: ${Object.keys(deps.roster.agents).join(", ")}`,
    );
  }
  if (deps.local !== undefined && deps.local.agent === agent) {
    return { kind: "local", socketPath: deps.local.socketPath };
  }
  const override = deps.endpointOverrides?.[agent];
  const base =
    override ?? agentUrl(entry, { tailnetDomain: deps.tailnetDomain }).replace(/\/a2a\/v1$/, "");
  return { kind: "peer", rpcUrl: `${base}/a2a/v1` };
}

/** How long a fire-and-forget send waits to be accepted. A cold agentd is slow, not silent. */
const ACCEPT_TIMEOUT_MS = 30_000;
/** How long `--wait` will sit on a turn. */
const WAIT_TIMEOUT_MS = 60 * 60_000;

/**
 * The command. Errors that mean "not delivered" are printed and become an
 * exit code rather than a stack trace: the caller is a shell script.
 */
export async function runSend(args: SendArgs, message: string, deps: SendDeps): Promise<number> {
  let route: SendRoute;
  try {
    route = resolveRoute(deps, args.agent);
  } catch (err) {
    deps.err(err instanceof Error ? err.message : String(err));
    return SEND_EXIT.undelivered;
  }

  let client: A2aJsonRpcClient;
  if (route.kind === "local") {
    client = new A2aJsonRpcClient(
      unixSocketHttp(route.socketPath, { [LOCAL_USER_HEADER]: deps.localUser }),
      "http://agentd/a2a/v1",
    );
  } else if (deps.peerHttp !== undefined) {
    client = new A2aJsonRpcClient(deps.peerHttp, route.rpcUrl);
  } else {
    deps.err(
      `no route to ${args.agent}: this account runs no netd egress socket, and ${args.agent} ` +
        `is not the agent this account runs`,
    );
    return SEND_EXIT.undelivered;
  }

  let result;
  try {
    result = await client.send({
      text: message,
      ...(args.contextId === undefined ? {} : { contextId: args.contextId }),
      messageIdPrefix: "send",
      metadata: {
        [META_TRIGGER]: TRIGGER_SEND,
        [META_SENDER]: deps.localUser,
        [META_UNATTENDED]: !args.wait,
      },
      returnImmediately: !args.wait,
      timeoutMs: args.wait ? WAIT_TIMEOUT_MS : ACCEPT_TIMEOUT_MS,
    });
  } catch (err) {
    deps.err(`${args.agent}: ${err instanceof Error ? err.message : String(err)}`);
    return SEND_EXIT.undelivered;
  }

  if (!args.wait) {
    deps.out(`${args.agent} accepted task ${result.taskId} (context ${result.contextId})`);
    return SEND_EXIT.ok;
  }
  if (result.text !== "") {
    deps.out(result.text);
  }
  // The coordinates go to stderr so a script capturing stdout gets the reply alone.
  deps.err(`[${args.agent} | task ${result.taskId} | context ${result.contextId} | ${result.state}]`);
  return result.state === "TASK_STATE_COMPLETED" ? SEND_EXIT.ok : SEND_EXIT.failed;
}
