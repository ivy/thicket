// Synthetic caller for the spike: Twilio dials the number from itself, and the caller
// leg runs a canned TwiML script — speech from <Say>, keypresses from <Play digits>,
// silence from <Pause> — so the relay leg (server.ts) sees a real call without a person.
//
//   mise exec -- bun spikes/conversationrelay/call.ts <scenario>
//
// The relay leg's behaviour is driven by the words the caller leg says (see server.ts
// VOICE_COMMANDS), so a scenario is just a script of what the "caller" says and when.

const env = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
};

const ACCOUNT = env("TWILIO_ACCOUNT_SID");
const KEY = env("TWILIO_API_KEY_SID");
const SECRET = env("TWILIO_API_KEY_SECRET");
const NUMBER = env("TWILIO_PHONE_NUMBER");
const BASE = env("THICKET_PUBLIC_BASE_URL").replace(/\/$/, "");

const say = (text: string) => `<Say>${text}</Say>`;
const pause = (s: number) => `<Pause length="${s}"/>`;
const keys = (digits: string) => `<Play digits="${digits}"/>`;

// Every scenario starts with a pause so the welcome greeting finishes first, unless the
// point is to act during it.
// A <Gather> on the caller leg hears the DTMF our sendDigits produces and reports it to
// /gather; a <Say> nested inside it is the caller talking while listening.
const gather = (inner = "") =>
  `<Gather input="dtmf" action="${BASE}/gather" method="POST" numDigits="5" timeout="30" actionOnEmptyResult="true">${inner}</Gather>`;

// Every scenario starts with a pause so the welcome greeting finishes first, unless the
// point is to act during it. Commands go by keypress (server.ts KEY_COMMANDS) because
// Flux hears a TTS voice say "long" as "Wrong." and "preempt" as "Prempt.".
const scenarios: Record<string, string> = {
  // An 8-digit test PIN (not the real one) spoken as digits, then a spoken sentence.
  pin: pause(5) + say("four seven two nine zero one three eight") + pause(8) + say("the quick brown fox") + pause(8) + "<Hangup/>",
  // A keypress while the greeting is still playing, then one after it.
  "greeting-dtmf": keys("9") + pause(6) + keys("8") + pause(6) + "<Hangup/>",
  // Say nothing for 90 s after the greeting; does anything end the session?
  silence: pause(5) + say("silence") + pause(90) + say("still here") + pause(8) + "<Hangup/>",
  // Trigger the long reply, then talk over it.
  interrupt: pause(5) + keys("1") + pause(6) + say("stop stop stop, I am interrupting you now") + pause(20) + "<Hangup/>",
  // Trigger the long reply with sendDigits fired 3 s into it; the caller leg listens for the tones.
  "busy-digits": pause(5) + keys("2") + gather() + "<Hangup/>",
  // Nothing playing, caller silent, listening for tones; the control port fires sendDigits at 8 s.
  "idle-digits": pause(5) + gather() + "<Hangup/>",
  // The caller talks for a while and listens for tones; the control port fires sendDigits meanwhile.
  "talking-digits": pause(5) + gather(say(Array.from({ length: 6 }, () => "I am the caller and I keep talking over the line.").join(" "))) + "<Hangup/>",
  // Trigger the long reply with a preemptible message 3 s into it.
  preempt: pause(5) + keys("6") + pause(80) + "<Hangup/>",
  // The long reply marked preemptible, then a plain message 3 s in.
  "preempt-marked": pause(5) + keys("0") + pause(80) + "<Hangup/>",
  // Hold the line for two minutes so the control port can drive end / drop / malformed.
  hold: pause(5) + say("holding") + pause(120) + "<Hangup/>",
  // The same, for one control command and a look at what follows.
  "hold-short": pause(5) + say("holding") + pause(45) + "<Hangup/>",
};

const name = process.argv[2] ?? "";
const twiml = scenarios[name];
if (!twiml) {
  console.error(`usage: call.ts <${Object.keys(scenarios).join("|")}>`);
  process.exit(2);
}

const body = new URLSearchParams({
  To: NUMBER,
  From: NUMBER,
  Twiml: `<?xml version="1.0" encoding="UTF-8"?><Response>${twiml}</Response>`,
  StatusCallback: `${BASE}/status`,
  StatusCallbackMethod: "POST",
});
for (const ev of ["initiated", "ringing", "answered", "completed"]) body.append("StatusCallbackEvent", ev);

const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT}/Calls.json`, {
  method: "POST",
  headers: { authorization: "Basic " + Buffer.from(`${KEY}:${SECRET}`).toString("base64") },
  body,
});
const json = (await res.json()) as Record<string, unknown>;
if (!res.ok) {
  console.error(JSON.stringify({ status: res.status, code: json.code, message: json.message, moreInfo: json.more_info }));
  process.exit(1);
}
// The caller leg's SID; the relay leg is the inbound call it places, a different SID.
console.log(JSON.stringify({ scenario: name, callerLeg: json.sid, status: json.status }));
