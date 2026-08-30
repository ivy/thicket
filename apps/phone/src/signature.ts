import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Twilio's request signature: HMAC-SHA1 over the URL it requested plus,
 * for a form POST, every parameter appended as key+value in key order;
 * base64; compared to `X-Twilio-Signature`. The URL is the one Twilio
 * dialled — our public base plus the path — never what a proxy rewrote
 * the Host header to. Only the account's primary auth token validates it.
 * https://www.twilio.com/docs/usage/webhooks/webhooks-security
 */
export function twilioSignature(authToken: string, url: string, params?: Record<string, string>): string {
  let data = url;
  if (params !== undefined) {
    for (const key of Object.keys(params).sort()) {
      data += key + params[key];
    }
  }
  return createHmac("sha1", authToken).update(data).digest("base64");
}

export function signatureValid(
  authToken: string,
  url: string,
  params: Record<string, string> | undefined,
  header: string | undefined,
): boolean {
  if (header === undefined || header === "") {
    return false;
  }
  const expected = Buffer.from(twilioSignature(authToken, url, params));
  const given = Buffer.from(header);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
