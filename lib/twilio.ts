import twilio from "twilio";
import { config } from "./config.js";

let cached: ReturnType<typeof twilio> | null = null;

export function twilioClient() {
  if (!cached) cached = twilio(config.twilioAccountSid, config.twilioAuthToken);
  return cached;
}

/** Where messages come from: the Messaging Service if configured, otherwise the bare number. */
function senderParams(): { messagingServiceSid: string } | { from: string } {
  if (config.twilioMessagingServiceSid) return { messagingServiceSid: config.twilioMessagingServiceSid };
  if (config.twilioPhoneNumber) return { from: config.twilioPhoneNumber };
  throw new Error("Set TWILIO_MESSAGING_SERVICE_SID or TWILIO_PHONE_NUMBER");
}

/** Send one text to the owner right now. */
export async function sendSms(body: string): Promise<string> {
  const msg = await twilioClient().messages.create({
    ...senderParams(),
    to: config.ownerPhone,
    body,
  });
  return msg.sid;
}

/** Twilio only schedules 15 minutes to 35 days ahead. */
export const SCHEDULE_MIN_MS = 15 * 60 * 1000 + 30 * 1000; // small buffer over 15 min
export const SCHEDULE_MAX_MS = 35 * 24 * 60 * 60 * 1000 - 60 * 60 * 1000; // a bit under 35 days

/** Ask Twilio to deliver a text at a future time. Requires a Messaging Service. Returns the message SID. */
export async function scheduleSms(body: string, sendAt: Date): Promise<string> {
  if (!config.twilioMessagingServiceSid) {
    throw new Error("Scheduled reminders need TWILIO_MESSAGING_SERVICE_SID");
  }
  const msg = await twilioClient().messages.create({
    messagingServiceSid: config.twilioMessagingServiceSid,
    to: config.ownerPhone,
    body,
    scheduleType: "fixed",
    sendAt,
  });
  return msg.sid;
}

export async function cancelScheduledSms(sid: string): Promise<void> {
  await twilioClient().messages(sid).update({ status: "canceled" });
}

/** Split a long reply into SMS-sized pieces, breaking at paragraph or sentence boundaries. */
export function chunkForSms(text: string, max = config.smsChunkChars): string[] {
  const clean = text.trim();
  if (clean.length <= max) return [clean];
  const chunks: string[] = [];
  let rest = clean;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n\n", max);
    if (cut < max * 0.5) cut = rest.lastIndexOf("\n", max);
    if (cut < max * 0.5) cut = rest.lastIndexOf(". ", max) + 1;
    if (cut < max * 0.5) cut = rest.lastIndexOf(" ", max);
    if (cut <= 0) cut = max;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}
