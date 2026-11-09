/**
 * Twilio calls this URL every time a text arrives at your Twilio number.
 *
 * Flow: verify it really came from Twilio -> verify it's from the owner -> answer Twilio immediately
 * (it stops waiting after 15 seconds) -> keep working in the background -> text the answer back.
 */
import { waitUntil } from "@vercel/functions";
import twilio from "twilio";
import { runAgent } from "../lib/agent.js";
import { config, normalizePhone } from "../lib/config.js";
import { learnFromExchange } from "../lib/memory.js";
import { personaStatus } from "../lib/persona.js";
import { store } from "../lib/store.js";
import { chunkForSms, sendSms } from "../lib/twilio.js";

const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

function twiml(body = "") {
  return new Response(
    body ? `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapeXml(body)}</Message></Response>` : EMPTY_TWIML,
    { status: 200, headers: { "Content-Type": "text/xml" } },
  );
}

function escapeXml(s: string) {
  return s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!);
}

/** Rebuild the exact public URL Twilio signed. Vercel sits behind a proxy, so use the forwarded host. */
function publicUrl(req: Request): string {
  const u = new URL(req.url);
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host") || u.host;
  const proto = req.headers.get("x-forwarded-proto") || "https";
  return `${proto}://${host}${u.pathname}${u.search}`;
}

export async function POST(req: Request): Promise<Response> {
  const form = await req.formData();
  const params: Record<string, string> = {};
  form.forEach((v, k) => {
    params[k] = String(v);
  });

  // 1. Is this really Twilio?
  if (config.validateTwilioSignature) {
    const signature = req.headers.get("x-twilio-signature") || "";
    const ok = twilio.validateRequest(config.twilioAuthToken, signature, publicUrl(req), params);
    if (!ok) {
      console.warn("sms: rejected request with bad Twilio signature");
      return new Response("Forbidden", { status: 403 });
    }
  }

  // 2. Is this the owner? Anyone else gets silence.
  const from = normalizePhone(params.From || "");
  if (from !== config.ownerPhone) {
    console.warn(`sms: ignoring message from ${from}`);
    return twiml();
  }

  const text = (params.Body || "").trim();
  if (!text) return twiml();

  // 3. "more" sends the next piece of a long answer without asking Claude again.
  //    Only when something is actually pending; otherwise "more"/"next" is just conversation.
  if (/^(more|next|continue)\.?$/i.test(text)) {
    const pending = await store.pending.load();
    if (pending && pending.chunks.length > 0) {
      const [next, ...rest] = pending.chunks;
      await store.pending.save(rest.length ? { chunks: rest, createdAt: pending.createdAt } : null);
      return twiml(rest.length ? `${next}\n\n(${rest.length} more. Text MORE.)` : next);
    }
  }

  // 4. Answer Twilio now; do the real work in the background and text the result.
  waitUntil(handleInBackground(text));
  return twiml();
}

async function handleInBackground(text: string): Promise<void> {
  try {
    const reply = await runAgent(text);
    if (reply) {
      const [first, ...rest] = chunkForSms(reply);
      await store.pending.save(rest.length ? { chunks: rest, createdAt: new Date().toISOString() } : null);
      await sendSms(rest.length ? `${first}\n\n(${rest.length} more. Text MORE.)` : first);
    }
    await learnFromExchange(text, reply || "(stayed silent)");
  } catch (err) {
    console.error("sms: failed to handle message", err);
    try {
      await sendSms("Sorry, something went wrong on my end. Please try again in a minute.");
    } catch (sendErr) {
      console.error("sms: could not even send the error text", sendErr);
    }
  }
}

/** Visiting the URL in a browser just confirms the service is up. */
export async function GET(): Promise<Response> {
  return new Response(`SMS assistant is running. Persona: ${personaStatus()}.`, { status: 200 });
}
