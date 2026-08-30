import { z } from "zod";

/**
 * The only code that knows ConversationRelay's message shapes. Inbound
 * JSON becomes the engine's own event vocabulary; outbound commands are
 * built here and validated before they are encoded, so a malformed frame
 * never leaves — Twilio closes the socket after ten of them. The shapes
 * are the ones recorded on the wire in tests/fixtures/conversationrelay/.
 */

export class RelayCodecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RelayCodecError";
  }
}

/** What the call tells the engine. */
export type CallEvent =
  | {
      kind: "setup";
      callSid: string;
      sessionId: string;
      from: string;
      to: string;
      direction: string;
      /** RINGING on a fresh call; IN_PROGRESS when `action` reconnected a relay to a live call. */
      callStatus: string;
      parameters: Record<string, string>;
    }
  | { kind: "speech"; text: string; final: boolean; lang: string }
  | { kind: "key"; digit: string }
  | { kind: "interrupt"; heard: string; afterMs: number }
  | { kind: "relay-error"; description: string }
  | { kind: "speaking"; who: "agent" | "caller"; on: boolean }
  | { kind: "played"; text: string }
  | { kind: "info"; name: string; value: string };

const setupSchema = z.object({
  type: z.literal("setup"),
  sessionId: z.string(),
  callSid: z.string().min(1),
  from: z.string(),
  to: z.string(),
  direction: z.string(),
  callStatus: z.string(),
  customParameters: z.record(z.string(), z.string()).default({}),
});
const promptSchema = z.object({
  type: z.literal("prompt"),
  voicePrompt: z.string(),
  lang: z.string().default(""),
  last: z.boolean(),
});
const dtmfSchema = z.object({ type: z.literal("dtmf"), digit: z.string().min(1) });
const interruptSchema = z.object({
  type: z.literal("interrupt"),
  utteranceUntilInterrupt: z.string().default(""),
  durationUntilInterruptMs: z.number().default(0),
});
const errorSchema = z.object({ type: z.literal("error"), description: z.string().default("") });
const infoSchema = z.object({ type: z.literal("info"), name: z.string(), value: z.string().default("") });

const inboundSchema = z.discriminatedUnion("type", [
  setupSchema,
  promptSchema,
  dtmfSchema,
  interruptSchema,
  errorSchema,
  infoSchema,
]);

/** A raw frame off the socket → one call event. Throws on anything else. */
export function decodeInbound(raw: string): CallEvent {
  let document: unknown;
  try {
    document = JSON.parse(raw);
  } catch {
    throw new RelayCodecError("inbound frame is not JSON");
  }
  const result = inboundSchema.safeParse(document);
  if (!result.success) {
    const type =
      typeof document === "object" && document !== null && "type" in document
        ? String((document as { type: unknown }).type)
        : "(none)";
    throw new RelayCodecError(`inbound frame of type ${type} is not one the codec knows: ${result.error.issues[0]?.message ?? ""}`);
  }
  const frame = result.data;
  switch (frame.type) {
    case "setup":
      return {
        kind: "setup",
        callSid: frame.callSid,
        sessionId: frame.sessionId,
        from: frame.from,
        to: frame.to,
        direction: frame.direction,
        callStatus: frame.callStatus,
        parameters: frame.customParameters,
      };
    case "prompt":
      return { kind: "speech", text: frame.voicePrompt, final: frame.last, lang: frame.lang };
    case "dtmf":
      return { kind: "key", digit: frame.digit };
    case "interrupt":
      return { kind: "interrupt", heard: frame.utteranceUntilInterrupt, afterMs: frame.durationUntilInterruptMs };
    case "error":
      return { kind: "relay-error", description: frame.description };
    case "info":
      if (frame.name === "agentSpeaking" || frame.name === "clientSpeaking") {
        return { kind: "speaking", who: frame.name === "agentSpeaking" ? "agent" : "caller", on: frame.value === "on" };
      }
      if (frame.name === "tokensPlayed") {
        return { kind: "played", text: frame.value };
      }
      return { kind: "info", name: frame.name, value: frame.value };
  }
}

/** What the engine tells the call. Built by the helpers below, never by hand. */
export type RelayCommand =
  | { type: "text"; token: string; last: boolean; preemptible?: boolean; interruptible?: boolean; lang?: string }
  | { type: "play"; source: string; loop?: number; preemptible?: boolean; interruptible?: boolean }
  | { type: "sendDigits"; digits: string }
  | { type: "language"; ttsLanguage?: string; transcriptionLanguage?: string }
  | { type: "end"; handoffData?: string };

/** One TTS token; `last` closes the utterance. `preemptible` marks it as cut-able by a later one. */
export function say(token: string, last: boolean, options: { preemptible?: boolean; interruptible?: boolean } = {}): RelayCommand {
  return { type: "text", token, last, ...options };
}

/** DTMF towards the far end. Queued behind whatever is playing. */
export function playDigits(digits: string): RelayCommand {
  return { type: "sendDigits", digits };
}

/** Play a media URL. */
export function playMedia(source: string, options: { loop?: number; preemptible?: boolean; interruptible?: boolean } = {}): RelayCommand {
  return { type: "play", source, ...options };
}

/** End the relay session; the call continues into whatever `action` returns. */
export function endSession(handoffData?: string): RelayCommand {
  return { type: "end", ...(handoffData === undefined ? {} : { handoffData }) };
}

const DIGITS = /^[0-9w#*]+$/;

const outboundSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("text"),
      token: z.string(),
      last: z.boolean(),
      preemptible: z.boolean().optional(),
      interruptible: z.boolean().optional(),
      lang: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("play"),
      source: z.string().min(1),
      loop: z.number().int().nonnegative().optional(),
      preemptible: z.boolean().optional(),
      interruptible: z.boolean().optional(),
    })
    .strict(),
  z
    .object({ type: z.literal("sendDigits"), digits: z.string().regex(DIGITS, { message: "digits are 0-9, w, #, * only" }) })
    .strict(),
  z
    .object({ type: z.literal("language"), ttsLanguage: z.string().min(1).optional(), transcriptionLanguage: z.string().min(1).optional() })
    .strict()
    .refine((l) => l.ttsLanguage !== undefined || l.transcriptionLanguage !== undefined, {
      message: "a language command names at least one language",
    }),
  z.object({ type: z.literal("end"), handoffData: z.string().optional() }).strict(),
]);

/** Validate and encode a command. Throws rather than let a bad frame out. */
export function encodeOutbound(command: RelayCommand): string {
  const result = outboundSchema.safeParse(command);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new RelayCodecError(
      `refusing to send a malformed ${String((command as { type?: unknown }).type)} frame: ${issue?.path.join(".") ?? ""} ${issue?.message ?? ""}`.trim(),
    );
  }
  return JSON.stringify(result.data);
}
