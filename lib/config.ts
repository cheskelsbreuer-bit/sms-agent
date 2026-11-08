/**
 * All configuration comes from environment variables set in the Vercel project.
 * Nothing secret is ever written into this repository.
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

function optional(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

/** Normalize a phone number to E.164 (+1XXXXXXXXXX) so comparisons are reliable. */
export function normalizePhone(raw: string): string {
  const digits = raw.replace(/[^\d]/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return raw.startsWith("+") ? raw : `+${digits}`;
}

export const config = {
  get anthropicApiKey() {
    return required("ANTHROPIC_API_KEY");
  },
  get twilioAccountSid() {
    return required("TWILIO_ACCOUNT_SID");
  },
  get twilioAuthToken() {
    return required("TWILIO_AUTH_TOKEN");
  },
  /** The Messaging Service that holds the Twilio number (starts with MG). Needed for scheduled reminders. */
  get twilioMessagingServiceSid() {
    return optional("TWILIO_MESSAGING_SERVICE_SID", "");
  },
  /** The Twilio phone number, used only if no Messaging Service is configured. */
  get twilioPhoneNumber() {
    return optional("TWILIO_PHONE_NUMBER", "");
  },
  /** The ONLY phone number the assistant answers. Everyone else is ignored. */
  get ownerPhone() {
    return normalizePhone(required("MY_PHONE"));
  },
  get timezone() {
    return optional("TIMEZONE", "America/New_York");
  },
  get ownerName() {
    return optional("OWNER_NAME", "");
  },
  /** Shared secret so only Vercel's scheduler can call /api/cron. */
  get cronSecret() {
    return optional("CRON_SECRET", "");
  },
  /** Set to "false" to skip Twilio signature validation while debugging. Leave on. */
  get validateTwilioSignature() {
    return optional("VALIDATE_TWILIO_SIGNATURE", "true") !== "false";
  },
  model: "claude-opus-5-5",
  /** Keep this many past turns (user + assistant texts) as conversation memory. */
  historyTurns: 40,
  /** Longest single SMS we send. Twilio's limit is 1600; shorter is easier to read on a phone. */
  smsChunkChars: 1200,
};
