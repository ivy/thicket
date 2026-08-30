import type { AlertPort, EngineLogger, PhoneAlert } from "./engine.js";

/** A number as it may be shown: the country code and the last four digits. */
export function maskNumber(number: string, showNumbers = false): string {
  if (showNumbers) {
    return number;
  }
  return number.length < 8 ? "…" : `${number.slice(0, 2)}…${number.slice(-4)}`;
}

function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) {
    return `${s}s`;
  }
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

function clock(ms: number): string {
  return new Date(ms).toISOString().slice(11, 16) + " UTC";
}

/** One line of Slack mrkdwn per alert. Never a word of the call, never the PIN. */
export function renderAlert(alert: PhoneAlert, options: { showNumbers?: boolean } = {}): string {
  const number = (n: string) => `\`${maskNumber(n, options.showNumbers)}\``;
  switch (alert.kind) {
    case "session_started":
      return `:telephone_receiver: Phone session started with *${alert.agent}* — ${alert.resumed ? "resumed" : "new session"}, authenticated by PIN`;
    case "session_ended":
      return `:telephone: Phone session with *${alert.agent}* ended after ${duration(alert.durationMs)} — ${
        alert.reason === "goodbye" ? "the operator said goodbye" : alert.reason === "switched" ? "switched agent" : "call dropped"
      }`;
    case "auth_failed":
      return alert.final
        ? `:no_entry: PIN wrong from listed number ${number(alert.from)} (attempt ${alert.attempt}, the last) — call ended: auth failed`
        : `:no_entry: PIN wrong from listed number ${number(alert.from)} (attempt ${alert.attempt})`;
    case "locked_out":
      return `:lock: ${number(alert.from)} locked out until ${clock(alert.untilMs)} after repeated PIN failures`;
    case "caller_rejected":
      return alert.reason === "locked"
        ? `:no_entry_sign: Call from ${number(alert.from)} refused: locked out until ${alert.untilMs === undefined ? "later" : clock(alert.untilMs)} — no session`
        : `:no_entry_sign: Call from unlisted number ${number(alert.from)} refused — no session`;
  }
}

export interface SlackAlertOptions {
  channel: string;
  botToken: string;
  showNumbers?: boolean;
  logger: EngineLogger;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Posts each alert to the security channel with a bot token from the
 * bridge's config. Best-effort by contract: a post that fails is a warning
 * in the log and nothing else — the call never waits on Slack and never
 * fails because of it. Plain fetch with a short timeout, deliberately not
 * the Web API client whose default retry policy can wait for hours.
 */
export class SlackAlertPoster implements AlertPort {
  private readonly channel: string;
  private readonly token: string;
  private readonly showNumbers: boolean;
  private readonly logger: EngineLogger;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: SlackAlertOptions) {
    this.channel = options.channel;
    this.token = options.botToken;
    this.showNumbers = options.showNumbers ?? false;
    this.logger = options.logger;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 5000;
  }

  async post(alert: PhoneAlert): Promise<void> {
    const text = renderAlert(alert, { showNumbers: this.showNumbers });
    try {
      const response = await this.fetchImpl("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.token}`,
          "content-type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({ channel: this.channel, text }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const body = (await response.json()) as { ok?: boolean; error?: string; ts?: string };
      if (!response.ok || body.ok !== true) {
        this.logger.warn("alert post failed", { kind: alert.kind, status: response.status, error: body.error ?? "unknown" });
        return;
      }
      this.logger.info("alert posted", { kind: alert.kind, ts: body.ts });
    } catch (err) {
      this.logger.warn("alert post failed", { kind: alert.kind, err: String(err) });
    }
  }
}
