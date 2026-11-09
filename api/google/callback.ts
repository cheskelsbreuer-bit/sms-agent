/** Google sends the browser back here after consent. Stores the account and shows a plain confirmation. */
import { completeLink, verifyState } from "../../lib/google.js";

function page(text: string, status = 200) {
  return new Response(`<!doctype html><meta charset="utf-8"><body style="font:18px system-ui;padding:2em">${text}</body>`, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const error = url.searchParams.get("error");
  if (error) return page(`Google said: ${error}. Nothing was linked.`, 400);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state") || "";
  if (!code || !verifyState(state)) return page("Invalid or expired link. Start again from /api/google/auth.", 400);
  try {
    const email = await completeLink(code);
    return page(`Linked <b>${email}</b>. You can close this tab and text your assistant "which email accounts do you have".`);
  } catch (err) {
    return page(`Could not finish linking: ${(err as Error).message}`, 500);
  }
}
