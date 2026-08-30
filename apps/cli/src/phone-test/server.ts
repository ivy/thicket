import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AwaitedUtterance, LegStatus, PlaceOptions, PlaceResult, TranscriptEntry } from "./leg.js";

/**
 * The synthetic operator (#51): the phone's `slack-test-mcp`. It places a
 * real call into the bridge, keys the PIN, hears what Aiva and the agent
 * say, speaks back, barges in, hangs up — so a live check can stand where
 * the operator stands. Reading the bridge's side (its log, the registry,
 * #security-alerts) stays with the tools that already do it; nothing here
 * duplicates them.
 */

export interface PhoneTestLegPort {
  place(options: PlaceOptions): Promise<PlaceResult>;
  say(text: string, options?: { overSpeech?: boolean }): Promise<{ playbackObserved: boolean }>;
  press(digits: string): Promise<void>;
  enterPin(): Promise<void>;
  awaitReply(options?: { timeoutMs?: number }): Promise<AwaitedUtterance>;
  transcript(): TranscriptEntry[];
  status(): LegStatus;
  hangup(how?: "end" | "rest"): Promise<void>;
}

function text(body: string) {
  return { content: [{ type: "text" as const, text: body }] };
}

function failure(err: unknown) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }],
  };
}

export function buildPhoneTestServer(deps: { leg: PhoneTestLegPort }): McpServer {
  const { leg } = deps;
  const server = new McpServer({ name: "thicket-phone-test", version: "0.1.0" });

  server.registerTool(
    "phone_call",
    {
      description:
        "Place a real call into the phone bridge as the operator. pin=dial keys the " +
        "PIN as post-dial digits (the saved-contact shape), pin=none leaves the gate " +
        "shut for auth tests. Returns when the caller leg's setup arrives; retries " +
        "when the Funnel edge refuses. The call then stays up for the other tools.",
      inputSchema: {
        pin: z.enum(["dial", "none"]).optional().describe("default dial"),
        attempts: z.number().int().min(1).max(5).optional().describe("edge-refusal retries, default 3"),
      },
    },
    async ({ pin, attempts }) => {
      try {
        const result = await leg.place({ ...(pin === undefined ? {} : { pin }), ...(attempts === undefined ? {} : { attempts }) });
        return text(
          `callSid=${result.callSid} attempts=${result.attempts} — the call is up` +
            (pin === "none" ? "; the PIN has not been keyed" : "; the PIN went out post-dial, listen for the hello"),
        );
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "phone_say",
    {
      description:
        "Speak on the call and return once it has been spoken. over_speech=true " +
        "queues it immediately instead — while the far end is talking, that is a " +
        "barge-in, which the bridge hears as an interrupt.",
      inputSchema: {
        text: z.string().min(1).describe("spoken via TTS; keep it a short, single-breath phrase"),
        over_speech: z.boolean().optional(),
      },
    },
    async ({ text: phrase, over_speech }) => {
      try {
        const result = await leg.say(phrase, { overSpeech: over_speech === true });
        return text(over_speech === true ? "queued over the far end's speech" : result.playbackObserved ? "spoken" : "queued (playback not observed before the timeout)");
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "phone_await_reply",
    {
      description:
        "Block until the far end finishes an utterance, then return what was heard " +
        "with when. The assertion most live checks reduce to. Each call returns the " +
        "next unreturned utterance; transcripts are Flux's hearing of a TTS voice, " +
        "so match distinctive words, not sentences.",
      inputSchema: {
        timeout_ms: z.number().int().min(1000).max(300_000).optional().describe("default 45000"),
      },
    },
    async ({ timeout_ms }) => {
      try {
        const heard = await leg.awaitReply(timeout_ms === undefined ? {} : { timeoutMs: timeout_ms });
        return text(
          `heard at ${heard.atMs}ms${heard.sinceSaidMs === undefined ? "" : ` (${heard.sinceSaidMs}ms after the last say ended)`}:\n${heard.text}`,
        );
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "phone_press",
    {
      description:
        "Key DTMF digits on the call (0-9, *, #). For the PIN use phone_enter_pin — " +
        "digits given here are still masked in the transcript, but the PIN should " +
        "never travel through a tool argument at all.",
      inputSchema: { digits: z.string().regex(/^[0-9*#w]{1,32}$/).describe("w waits half a second") },
    },
    async ({ digits }) => {
      try {
        await leg.press(digits);
        return text(`${digits.length} digit(s) keyed`);
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "phone_enter_pin",
    {
      description:
        "Key the configured PIN on the keypad — the hand-keyed auth path. The digits " +
        "come from the tool's own config and never appear in results, transcripts, " +
        "logs or recordings.",
      inputSchema: {},
    },
    async () => {
      try {
        await leg.enterPin();
        return text("PIN keyed (8 digits)");
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "phone_transcript",
    {
      description: "The whole two-sided transcript so far: said, heard, keyed (digits masked), and call events, timestamped.",
      inputSchema: {},
    },
    () => {
      try {
        const lines = leg.transcript().map((entry) => `${String(entry.ms).padStart(7)}ms ${entry.who.padEnd(5)} ${entry.text}`);
        return text(lines.length === 0 ? "(nothing yet)" : lines.join("\n"));
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "phone_status",
    {
      description: "Whether a call is up, who is speaking right now, and how many heard utterances phone_await_reply has not returned yet.",
      inputSchema: {},
    },
    () => {
      try {
        const status = leg.status();
        return text(
          status.call === null
            ? "no call"
            : `call ${status.call.callSid} up ${Math.round(status.call.sinceSetupMs / 1000)}s · ` +
                `far ${status.farSpeaking ? "speaking" : "quiet"} · self ${status.selfSpeaking ? "speaking" : "quiet"} · ` +
                `${status.heardPending} heard pending`,
        );
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "phone_hangup",
    {
      description:
        "End the call from this side. how=end sends the relay end frame (the clean " +
        "wrap-up); how=rest completes the call over Twilio's REST API (the abrupt " +
        "one). Saying goodbye instead is phone_say — the bridge hangs up itself.",
      inputSchema: { how: z.enum(["end", "rest"]).optional().describe("default end") },
    },
    async ({ how }) => {
      try {
        await leg.hangup(how ?? "end");
        return text("call ended");
      } catch (err) {
        return failure(err);
      }
    },
  );

  return server;
}
