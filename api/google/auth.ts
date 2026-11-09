/**
 * Start linking a Gmail account. Open in a browser, once per account:
 *   https://<your-app>/api/google/auth?key=<CRON_SECRET>
 * The key stops strangers from linking their own mailbox to your assistant.
 */
import { config } from "../../lib/config.js";
import { authUrl } from "../../lib/google.js";

export async function GET(req: Request): Promise<Response> {
  const key = new URL(req.url).searchParams.get("key") || "";
  if (!config.cronSecret || key !== config.cronSecret) return new Response("Forbidden", { status: 403 });
  if (!config.googleClientId || !config.googleClientSecret) {
    return new Response("GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not set in Vercel yet.", { status: 500 });
  }
  return Response.redirect(authUrl(), 302);
}
