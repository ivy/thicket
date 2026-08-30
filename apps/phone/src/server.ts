import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

import { WebSocketServer, type WebSocket } from "ws";

import { decodeInbound, encodeOutbound, RelayCodecError, type CallEvent, type RelayCommand } from "./codec.js";
import type { AlertPort, CallEngine, EngineLogger, PhoneAlert, RelayPort } from "./engine.js";
import type { CallRegistry } from "./registry.js";
import { signatureValid } from "./signature.js";

/**
 * The <ConversationRelay> attributes the bridge answers a call with. No
 * greeting: the PIN is the first thing on the wire and nothing is spoken
 * before it is checked. The spike (tests/fixtures/conversationrelay/)
 * recorded what each of these does.
 */
export const RELAY_ATTRIBUTES: Record<string, string> = {
  transcriptionProvider: "Deepgram",
  speechModel: "flux",
  dtmfDetection: "true",
  interruptible: "any",
  reportInputDuringAgentSpeech: "any",
  events: "speaker-events tokens-played",
};

export interface PhoneServerOptions {
  /** Where Twilio reaches us: the https origin the signatures are computed over. */
  publicBaseUrl: string;
  /** The account's primary auth token — the only thing that validates a signature. */
  authToken: string;
  registry: CallRegistry;
  /** One engine per relay session, wired to the socket it will speak through. */
  engineFor(relay: RelayPort, alerts: AlertPort): CallEngine;
  /** Where alerts go once the registry has seen them. */
  alerts: AlertPort;
  logger: EngineLogger;
  clock?: () => number;
  /** Test override for the path secret; random per process otherwise. */
  relaySecret?: string;
}

export interface PhoneServer {
  server: Server;
  /** The relay path with its secret, for whoever renders the TwiML. */
  relayPath: string;
  close(): Promise<void>;
}

function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!);
}

function twiml(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Response>${body}</Response>`;
}

/** What a frame looks like in the log: its kind and its size, never its words or digits. */
function shapeOf(event: CallEvent): Record<string, unknown> {
  switch (event.kind) {
    case "setup":
      return { kind: event.kind, callSid: event.callSid, direction: event.direction, callStatus: event.callStatus };
    case "speech":
      return { kind: event.kind, chars: event.text.length, final: event.final };
    case "key":
      return { kind: event.kind };
    case "interrupt":
      return { kind: event.kind, heardChars: event.heard.length, afterMs: event.afterMs };
    case "relay-error":
      return { kind: event.kind, description: event.description };
    case "speaking":
      return { kind: event.kind, who: event.who, on: event.on };
    case "played":
      return { kind: event.kind, chars: event.text.length };
    case "info":
      return { kind: event.kind, name: event.name };
  }
}

function commandShape(command: RelayCommand): Record<string, unknown> {
  switch (command.type) {
    case "text":
      return { type: command.type, chars: command.token.length, last: command.last, preemptible: command.preemptible };
    case "sendDigits":
      return { type: command.type, digits: command.digits.length };
    default:
      return { type: command.type };
  }
}

/**
 * The parts of the phone bridge that touch the world: the WebSocket Twilio
 * connects to, the voice webhook that answers a call with TwiML, the
 * session-end webhook, and the status callback. Every request is checked
 * against Twilio's signature before anything is read from it; the relay
 * path carries a secret besides. Nothing else is trusted from a request.
 */
export function buildPhoneServer(options: PhoneServerOptions): PhoneServer {
  const { registry, logger } = options;
  const now = options.clock ?? (() => Date.now());
  const base = options.publicBaseUrl.replace(/\/$/, "");
  const host = new URL(base).host;
  const secret = options.relaySecret ?? randomBytes(16).toString("hex");
  const relayPath = `/relay/${secret}`;
  const wss = new WebSocketServer({ noServer: true });
  const sockets = new Set<WebSocket>();

  const readForm = (req: IncomingMessage): Promise<Record<string, string>> =>
    new Promise((resolve, reject) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk: string) => {
        body += chunk;
        if (body.length > 64 * 1024) {
          reject(new Error("body too large"));
          req.destroy();
        }
      });
      req.on("end", () => resolve(Object.fromEntries(new URLSearchParams(body).entries())));
      req.on("error", reject);
    });

  const answer = (res: ServerResponse, status: number, body: string, type = "text/plain"): void => {
    res.writeHead(status, { "content-type": type });
    res.end(body);
  };

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", base);
      const path = url.pathname;
      if (req.method !== "POST" || !["/voice", "/action", "/status"].includes(path)) {
        logger.info("request refused", { method: req.method, path, status: 404 });
        answer(res, 404, "not found");
        return;
      }
      let form: Record<string, string>;
      try {
        form = await readForm(req);
      } catch (err) {
        logger.warn("webhook body unreadable", { path, err: String(err) });
        answer(res, 400, "bad request");
        return;
      }
      const header = req.headers["x-twilio-signature"];
      if (!signatureValid(options.authToken, `${base}${path}`, form, typeof header === "string" ? header : undefined)) {
        logger.warn("webhook refused: bad signature", { path, status: 403 });
        answer(res, 403, "forbidden");
        return;
      }
      const callSid = form.CallSid ?? "";
      switch (path) {
        case "/voice": {
          registry.recordCall({
            callSid,
            from: form.From ?? "",
            to: form.To ?? "",
            direction: form.Direction ?? "",
            startedMs: now(),
          });
          logger.info("webhook", { path, callSid, direction: form.Direction, callStatus: form.CallStatus });
          const attrs = Object.entries({ url: `wss://${host}${relayPath}`, ...RELAY_ATTRIBUTES })
            .map(([k, v]) => `${k}="${escapeXml(v)}"`)
            .join(" ");
          answer(res, 200, twiml(`<Connect action="${base}/action"><ConversationRelay ${attrs}/></Connect>`), "text/xml");
          return;
        }
        case "/action": {
          // The relay session is over. Why, in Twilio's words and ours, is
          // the wrap-up record — recorded even when the bridge that ran the
          // session is not the one answering.
          const handoff = form.HandoffData ?? "";
          const reason = handoff !== "" ? handoff : form.ErrorCode !== undefined ? `${form.SessionStatus}:${form.ErrorCode}` : (form.SessionStatus ?? "unknown");
          const recorded = registry.endCall(callSid, now(), reason);
          logger.info("webhook", {
            path,
            callSid,
            sessionStatus: form.SessionStatus,
            reason,
            sessionSeconds: form.SessionDuration,
            recorded,
          });
          const goodbye = handoff === "goodbye" ? "<Say>Goodbye.</Say>" : "";
          answer(res, 200, twiml(`${goodbye}<Hangup/>`), "text/xml");
          return;
        }
        case "/status": {
          if (form.CallStatus === "completed" || form.CallStatus === "failed" || form.CallStatus === "busy" || form.CallStatus === "no-answer") {
            registry.endCall(callSid, now(), `call:${form.CallStatus}`);
          }
          logger.info("webhook", { path, callSid, callStatus: form.CallStatus, seconds: form.CallDuration });
          answer(res, 204, "");
          return;
        }
      }
    })().catch((err: unknown) => {
      logger.warn("webhook failed", { err: String(err) });
      if (!res.headersSent) {
        answer(res, 500, "error");
      }
    });
  });

  const refuse = (socket: Duplex, status: number, reason: string, fields: Record<string, unknown>): void => {
    logger.warn("handshake refused", { reason, status, ...fields });
    socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
  };

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", base);
    if (url.pathname !== relayPath) {
      refuse(socket, 404, "Not Found", { path: url.pathname });
      return;
    }
    const header = req.headers["x-twilio-signature"];
    // The spike found the handshake signed over the wss URL exactly as written in the TwiML.
    if (!signatureValid(options.authToken, `wss://${host}${relayPath}`, undefined, typeof header === "string" ? header : undefined)) {
      refuse(socket, 403, "Forbidden", { path: relayPath, signature: header === undefined ? "missing" : "bad" });
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.add(ws);
      attach(ws);
    });
  });

  const attach = (ws: WebSocket): void => {
    let callSid = "";
    const relay: RelayPort = {
      send: (command) => {
        const encoded = encodeOutbound(command);
        logger.info("command", { callSid, ...commandShape(command) });
        ws.send(encoded);
      },
    };
    // The registry learns which agent and session a call reached from the
    // engine's own alert, then the alert goes on to wherever alerts go.
    const alerts: AlertPort = {
      post: async (alert: PhoneAlert) => {
        if (alert.kind === "session_started") {
          registry.attachSession(alert.callSid, alert.agent, alert.contextId);
        }
        await options.alerts.post(alert);
      },
    };
    const engine = options.engineFor(relay, alerts);
    let chain: Promise<void> = Promise.resolve();
    logger.info("relay connected", {});

    ws.on("message", (data) => {
      const raw = typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
      let event: CallEvent;
      try {
        event = decodeInbound(raw);
      } catch (err) {
        logger.warn("frame ignored", { callSid, err: err instanceof RelayCodecError ? err.message : String(err) });
        return;
      }
      if (event.kind === "setup") {
        callSid = event.callSid;
        registry.recordCall({ callSid, from: event.from, to: event.to, direction: event.direction, startedMs: now() });
      }
      logger.info("frame", { callSid, ...shapeOf(event) });
      // Frames are handled in order; a slow handler must not reorder the next.
      chain = chain.then(() => engine.handle(event)).catch((err: unknown) => {
        logger.warn("frame handling failed", { callSid, kind: event.kind, err: String(err) });
      });
    });
    ws.on("close", (code, reason) => {
      sockets.delete(ws);
      logger.info("relay closed", { callSid, code, reason: reason.toString(), state: engine.state });
      chain = chain.then(() => engine.hangup()).catch((err: unknown) => {
        logger.warn("hangup handling failed", { callSid, err: String(err) });
      });
    });
    ws.on("error", (err) => {
      logger.warn("relay socket error", { callSid, err: String(err) });
    });
  };

  return {
    server,
    relayPath,
    close: () =>
      new Promise<void>((resolve) => {
        for (const ws of sockets) {
          ws.terminate();
        }
        wss.close();
        server.close(() => resolve());
      }),
  };
}
