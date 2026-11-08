/**
 * Runs once a day (see vercel.json). Twilio can only schedule texts up to 35 days ahead, so reminders set
 * further out wait here until they come into range. Also tidies up reminders that have already gone out.
 */
import { config } from "../lib/config.js";
import { store } from "../lib/store.js";
import { SCHEDULE_MAX_MS, SCHEDULE_MIN_MS, scheduleSms } from "../lib/twilio.js";

export async function GET(req: Request): Promise<Response> {
  if (config.cronSecret) {
    const auth = req.headers.get("authorization") || "";
    if (auth !== `Bearer ${config.cronSecret}`) return new Response("Unauthorized", { status: 401 });
  }

  const reminders = await store.reminders.load();
  const now = Date.now();
  let scheduled = 0;
  let marked = 0;

  for (const r of reminders) {
    const lead = new Date(r.sendAt).getTime() - now;
    if (r.status === "waiting" && lead <= SCHEDULE_MAX_MS) {
      const when = new Date(Math.max(new Date(r.sendAt).getTime(), now + SCHEDULE_MIN_MS));
      r.twilioSid = await scheduleSms(`Reminder: ${r.text}`, when);
      r.status = "scheduled";
      scheduled++;
    } else if (r.status === "scheduled" && lead < -60_000) {
      r.status = "sent";
      marked++;
    }
  }

  // Keep the file small: drop sent/canceled reminders older than 30 days.
  const keep = reminders.filter(
    (r) => (r.status !== "sent" && r.status !== "canceled") || now - new Date(r.sendAt).getTime() < 30 * 86_400_000,
  );
  await store.reminders.save(keep);

  return Response.json({ ok: true, scheduled, markedSent: marked, total: keep.length });
}
