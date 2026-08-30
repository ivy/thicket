import { join } from "node:path";

import { stateDir } from "@thicket/roster";

import { HttpTwilioRest } from "./caller.js";
import type { PhoneTestConfig } from "./config.js";
import { CallerLeg, type LegLogger } from "./leg.js";
import { SCENARIOS, ScenarioFailure, type ScenarioContext } from "./scenarios.js";

/**
 * `thicket phone-test run <scenario|all>` — the live suite against the
 * rig: real calls, real PSTN, the real bridge. Asserts only on this leg's
 * own hearing; the bridge's records are read with the tools that already
 * exist. Exits non-zero when anything differs from what the scenario
 * expects, saying what was heard instead.
 */

export interface RunnerIo {
  out(line: string): void;
  logger: LegLogger;
}

/** Eight digits guaranteed to differ from the PIN in every position. */
export function notThePin(pin: string): string {
  return [...pin].map((digit) => String((Number(digit) + 1) % 10)).join("");
}

export async function runPhoneTest(args: string[], config: PhoneTestConfig, io: RunnerIo): Promise<number> {
  const [sub, name] = args;
  if (sub === "list") {
    for (const scenario of SCENARIOS) {
      io.out(`${scenario.name.padEnd(18)} ${scenario.proves}`);
    }
    return 0;
  }
  if (sub !== "run" || name === undefined) {
    io.out("usage: thicket phone-test run <scenario|all> | list | redact <recording>…");
    return 2;
  }
  const picked = name === "all" ? SCENARIOS : SCENARIOS.filter((scenario) => scenario.name === name);
  if (picked.length === 0) {
    io.out(`no scenario named ${name} — try: thicket phone-test list`);
    return 2;
  }

  const recordingsDir = config.recordings_dir ?? join(stateDir(), "phone-test", "recordings");
  const leg = new CallerLeg({
    publicBaseUrl: config.public_base_url,
    pathPrefix: config.path_prefix,
    authToken: config.twilio.auth_token,
    pin: config.pin,
    rest: new HttpTwilioRest({
      accountSid: config.twilio.account_sid,
      authToken: config.twilio.auth_token,
      ...(config.twilio.api_key_sid === undefined ? {} : { apiKeySid: config.twilio.api_key_sid }),
      ...(config.twilio.api_key_secret === undefined ? {} : { apiKeySecret: config.twilio.api_key_secret }),
      to: config.number,
      ...(config.from === undefined ? {} : { from: config.from }),
    }),
    recordingsDir,
    logger: io.logger,
  });
  const server = leg.createServer();
  const [hostname, port] = config.listen.split(":");
  await new Promise<void>((resolve) => server.listen(Number(port), hostname, () => resolve()));

  const context: ScenarioContext = {
    leg,
    agentName: process.env.THICKET_PHONE_TEST_AGENT ?? "Hearth",
    wrongPin: notThePin(config.pin),
    ...(process.env.THICKET_PHONE_TEST_UNLISTED_FROM === undefined
      ? {}
      : { unlistedFrom: process.env.THICKET_PHONE_TEST_UNLISTED_FROM }),
    log: (line) => io.out(`      ${line}`),
  };

  let failures = 0;
  try {
    for (const scenario of picked) {
      const reason = scenario.skip?.(context);
      if (reason !== undefined) {
        io.out(`SKIP  ${scenario.name} — ${reason}`);
        continue;
      }
      const started = Date.now();
      let verdict: string | undefined;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          await scenario.run(context);
          verdict = undefined;
          break;
        } catch (err) {
          if (err instanceof ScenarioFailure) {
            // A behavioural difference: what was heard was wrong. Never retried.
            verdict = err.message;
            break;
          }
          const detail = err instanceof Error ? err.message : String(err);
          if (leg.status().call !== null) {
            await leg.hangup("rest").catch(() => undefined);
          }
          if (attempt === 1) {
            // Infrastructure, not behaviour — the Funnel edge drops connects in
            // stretches (#50). One more try after the stretch has had time to pass.
            io.out(`      ${scenario.name}: infrastructure got in the way (${detail.split(" — ")[0]}); retrying after a breather`);
            await new Promise((resolve) => setTimeout(resolve, 30_000));
          } else {
            verdict = `broke: ${detail}`;
          }
        }
      }
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      if (verdict === undefined) {
        io.out(`PASS  ${scenario.name} (${seconds}s)`);
      } else {
        failures += 1;
        io.out(`FAIL  ${scenario.name} (${seconds}s) — ${verdict}`);
      }
      // A failed scenario must not leave its call to the next one.
      if (leg.status().call !== null) {
        await leg.hangup("rest").catch(() => undefined);
      }
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  io.out(`recordings: ${recordingsDir}`);
  return failures === 0 ? 0 : 1;
}
