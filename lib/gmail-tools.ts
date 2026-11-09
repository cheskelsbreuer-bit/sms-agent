/**
 * Email tools for the agent. Reading is free; sending only happens after the owner says yes.
 */
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { config } from "./config.js";
import { loadAccounts, markRead, readEmail, resolveAccount, searchEmail, sendEmail, type GoogleAccount } from "./google.js";
import { formatWhen } from "./tools.js";

const accountHint = z
  .string()
  .optional()
  .describe("Which Gmail account: the address or a distinctive part of it (e.g. '2039'). Omit to use all linked accounts.");

/** Resolve the hint to exactly one account, or explain why not. */
async function oneAccount(hint?: string): Promise<GoogleAccount | string> {
  const r = await resolveAccount(hint);
  if (!r) return "No Gmail account is linked yet.";
  if (Array.isArray(r)) return `Which account? Linked: ${r.map((a) => a.email).join(", ")}`;
  return r;
}

function shortFrom(from: string): string {
  const m = from.match(/^"?([^"<]+)"?\s*<([^>]+)>$/);
  return m ? `${m[1].trim()} <${m[2]}>` : from;
}

function fmtDate(d: string): string {
  const t = new Date(d);
  return Number.isNaN(t.getTime()) ? d : formatWhen(t.toISOString());
}

export const listEmailAccounts = betaZodTool({
  name: "list_email_accounts",
  description: "List the Gmail accounts linked to this assistant.",
  inputSchema: z.object({}),
  run: async () => {
    const accounts = await loadAccounts();
    if (accounts.length === 0) return "No Gmail accounts linked yet.";
    return accounts.map((a) => a.email).join("\n");
  },
});

export const searchEmailTool = betaZodTool({
  name: "search_email",
  description:
    "Search the owner's Gmail. Uses Gmail search syntax: 'is:unread', 'from:someone', 'newer_than:2d', 'subject:invoice', plain words. For 'what's new' use 'is:unread newer_than:3d' or 'in:inbox newer_than:1d'. Returns id, from, subject, date and a snippet for each hit.",
  inputSchema: z.object({
    query: z.string().describe("Gmail search query."),
    account: accountHint,
    max: z.number().int().min(1).max(10).optional().describe("How many results per account (default 5)."),
  }),
  run: async ({ query, account, max }) => {
    const r = await resolveAccount(account);
    if (!r) return "No Gmail account is linked yet.";
    const accounts = Array.isArray(r) ? r : [r];
    const out: string[] = [];
    for (const acc of accounts) {
      try {
        const hits = await searchEmail(acc, query, max ?? 5);
        if (accounts.length > 1) out.push(`== ${acc.email} ==`);
        if (hits.length === 0) out.push("No matching emails.");
        for (const h of hits) {
          out.push(`[${h.id}] ${h.unread ? "(unread) " : ""}${fmtDate(h.date)} from ${shortFrom(h.from)}\n  ${h.subject}\n  ${h.snippet}`);
        }
      } catch (err) {
        out.push(`${acc.email}: error: ${(err as Error).message}`);
      }
    }
    return out.join("\n");
  },
});

export const readEmailTool = betaZodTool({
  name: "read_email",
  description: "Read one email in full by its id (from search_email). Returns headers, the body text (trimmed) and attachment names.",
  inputSchema: z.object({
    id: z.string().describe("The message id from search_email."),
    account: z.string().describe("The account the id came from (address or distinctive part)."),
    markAsRead: z.boolean().optional().describe("Mark it read in Gmail (default false)."),
  }),
  run: async ({ id, account, markAsRead }) => {
    const acc = await oneAccount(account);
    if (typeof acc === "string") return acc;
    const m = await readEmail(acc, id);
    if (markAsRead) await markRead(acc, id).catch(() => undefined);
    const body = m.body.length > 6000 ? `${m.body.slice(0, 6000)}\n[... trimmed, ${m.body.length} chars total]` : m.body;
    return [
      `From: ${shortFrom(m.from)}`,
      `To: ${m.to}`,
      `Date: ${fmtDate(m.date)}`,
      `Subject: ${m.subject}`,
      m.attachments.length ? `Attachments: ${m.attachments.join(", ")}` : "",
      "",
      body || "(no text body)",
    ]
      .filter((l) => l !== "")
      .join("\n");
  },
});

export const sendEmailTool = betaZodTool({
  name: "send_email",
  description:
    "Send an email from one of the owner's Gmail accounts. ONLY call this after you have shown the owner the exact recipient, subject and body and they replied yes/send/ok. Never send without that confirmation in the conversation. To reply in an existing thread, pass replyToId.",
  inputSchema: z.object({
    account: z.string().describe("Which account to send from (address or distinctive part)."),
    to: z.string().describe("Recipient address(es), comma separated."),
    subject: z.string(),
    body: z.string().describe("Plain-text body, written the way the owner would write it."),
    replyToId: z.string().optional().describe("Message id being replied to, if this is a reply."),
  }),
  run: async ({ account, to, subject, body, replyToId }) => {
    const acc = await oneAccount(account);
    if (typeof acc === "string") return acc;
    const id = await sendEmail(acc, { to, subject, body, replyToId });
    return `Sent from ${acc.email} to ${to} (id ${id}).`;
  },
});

export const gmailTools = [listEmailAccounts, searchEmailTool, readEmailTool, sendEmailTool];

export function gmailConfigured(): boolean {
  return Boolean(config.googleClientId && config.googleClientSecret);
}
