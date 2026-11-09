/**
 * Gmail access for one or more Google accounts, with plain fetch (no googleapis dependency).
 * Linking an account is a one-time browser step (api/google/auth.ts); after that only the
 * refresh token is kept, in Vercel Blob.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { get, put } from "@vercel/blob";
import { config } from "./config.js";

export interface GoogleAccount {
  email: string;
  refreshToken: string;
  addedAt: string;
}

const SCOPES = ["https://www.googleapis.com/auth/gmail.modify"];
const ACCOUNTS_PATH = "state/google-accounts.json";

export function redirectUri(): string {
  return `${config.baseUrl}/api/google/callback`;
}

// ---------- account storage ----------

export async function loadAccounts(): Promise<GoogleAccount[]> {
  try {
    const result = await get(ACCOUNTS_PATH, { access: "private", useCache: false });
    if (!result || result.statusCode !== 200) return [];
    return JSON.parse(await new Response(result.stream).text()) as GoogleAccount[];
  } catch {
    return [];
  }
}

async function saveAccounts(accounts: GoogleAccount[]): Promise<void> {
  await put(ACCOUNTS_PATH, JSON.stringify(accounts, null, 2), {
    access: "private",
    contentType: "application/json",
    addRandomSuffix: false,
    allowOverwrite: true,
    cacheControlMaxAge: 0,
  });
}

/** Find an account by full address or a distinctive part of it ("2039", "cheskels"). */
export async function resolveAccount(hint?: string): Promise<GoogleAccount | GoogleAccount[] | null> {
  const accounts = await loadAccounts();
  if (accounts.length === 0) return null;
  if (!hint) return accounts.length === 1 ? accounts[0] : accounts;
  const h = hint.toLowerCase().trim();
  const exact = accounts.find((a) => a.email.toLowerCase() === h);
  if (exact) return exact;
  const partial = accounts.filter((a) => a.email.toLowerCase().includes(h));
  if (partial.length === 1) return partial[0];
  if (accounts.length === 1) return accounts[0]; // a wrong hint can't be ambiguous with one account
  return partial.length ? partial : accounts;
}

// ---------- OAuth ----------

function signState(nonce: string): string {
  return createHmac("sha256", config.cronSecret || config.twilioAuthToken).update(nonce).digest("hex");
}

export function newState(): string {
  const nonce = randomBytes(12).toString("hex");
  return `${nonce}.${signState(nonce)}`;
}

export function verifyState(state: string): boolean {
  const [nonce, sig] = state.split(".");
  if (!nonce || !sig) return false;
  const expected = signState(nonce);
  return sig.length === expected.length && timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

export function authUrl(): string {
  const params = new URLSearchParams({
    client_id: config.googleClientId,
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent select_account",
    state: newState(),
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  error?: string;
  error_description?: string;
}

async function tokenRequest(body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.googleClientId,
      client_secret: config.googleClientSecret,
      ...body,
    }),
  });
  const json = (await res.json()) as TokenResponse;
  if (!res.ok || json.error) throw new Error(`Google token error: ${json.error_description || json.error || res.status}`);
  return json;
}

/** Finish linking: exchange the code, find out which address it is, store the refresh token. */
export async function completeLink(code: string): Promise<string> {
  const token = await tokenRequest({ code, grant_type: "authorization_code", redirect_uri: redirectUri() });
  if (!token.refresh_token) throw new Error("Google did not return a refresh token. Remove the app at myaccount.google.com/permissions and try again.");
  const profile = await gmailFetch<{ emailAddress: string }>(token.access_token, "profile");
  const accounts = (await loadAccounts()).filter((a) => a.email.toLowerCase() !== profile.emailAddress.toLowerCase());
  accounts.push({ email: profile.emailAddress, refreshToken: token.refresh_token, addedAt: new Date().toISOString() });
  await saveAccounts(accounts);
  return profile.emailAddress;
}

const accessTokens = new Map<string, { token: string; expiresAt: number }>();

async function accessTokenFor(account: GoogleAccount): Promise<string> {
  const cached = accessTokens.get(account.email);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
  const token = await tokenRequest({ refresh_token: account.refreshToken, grant_type: "refresh_token" });
  accessTokens.set(account.email, { token: token.access_token, expiresAt: Date.now() + token.expires_in * 1000 });
  return token.access_token;
}

// ---------- Gmail REST ----------

async function gmailFetch<T>(accessToken: string, pathAndQuery: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${pathAndQuery}`, {
    ...init,
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", ...(init?.headers || {}) },
  });
  if (!res.ok) throw new Error(`Gmail ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as T;
}

interface GmailHeader {
  name: string;
  value: string;
}
interface GmailPart {
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { data?: string; size?: number };
  parts?: GmailPart[];
}
interface GmailMessage {
  id: string;
  threadId: string;
  snippet?: string;
  internalDate?: string;
  labelIds?: string[];
  payload?: GmailPart;
}

export interface EmailSummary {
  id: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  snippet: string;
  unread: boolean;
}

function header(msg: GmailMessage, name: string): string {
  return msg.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || "";
}

function toSummary(msg: GmailMessage): EmailSummary {
  return {
    id: msg.id,
    threadId: msg.threadId,
    from: header(msg, "From"),
    to: header(msg, "To"),
    subject: header(msg, "Subject") || "(no subject)",
    date: header(msg, "Date"),
    snippet: msg.snippet || "",
    unread: msg.labelIds?.includes("UNREAD") ?? false,
  };
}

export async function searchEmail(account: GoogleAccount, query: string, max = 5): Promise<EmailSummary[]> {
  const token = await accessTokenFor(account);
  const q = new URLSearchParams({ q: query, maxResults: String(Math.min(Math.max(max, 1), 10)) });
  const list = await gmailFetch<{ messages?: { id: string }[] }>(token, `messages?${q}`);
  const ids = list.messages ?? [];
  const msgs = await Promise.all(
    ids.map((m) =>
      gmailFetch<GmailMessage>(
        token,
        `messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`,
      ),
    ),
  );
  return msgs.map(toSummary);
}

function decodeBody(data?: string): string {
  if (!data) return "";
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr|blockquote)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractText(part?: GmailPart): string {
  if (!part) return "";
  if (part.mimeType === "text/plain" && part.body?.data) return decodeBody(part.body.data);
  if (part.parts) {
    const plain = part.parts.map(extractText).filter(Boolean);
    if (plain.length) return plain.join("\n");
  }
  if (part.mimeType === "text/html" && part.body?.data) return htmlToText(decodeBody(part.body.data));
  return "";
}

export interface EmailFull extends EmailSummary {
  body: string;
  attachments: string[];
  messageIdHeader: string;
  references: string;
}

export async function readEmail(account: GoogleAccount, id: string): Promise<EmailFull> {
  const token = await accessTokenFor(account);
  const msg = await gmailFetch<GmailMessage>(token, `messages/${id}?format=full`);
  const attachments: string[] = [];
  const walk = (p?: GmailPart) => {
    if (!p) return;
    if (p.filename) attachments.push(p.filename);
    p.parts?.forEach(walk);
  };
  walk(msg.payload);
  let body = extractText(msg.payload);
  if (!body && msg.payload?.mimeType === "text/html") body = htmlToText(decodeBody(msg.payload.body?.data));
  return {
    ...toSummary(msg),
    body: body.replace(/\r\n/g, "\n").trim(),
    attachments,
    messageIdHeader: header(msg, "Message-ID"),
    references: header(msg, "References"),
  };
}

export async function markRead(account: GoogleAccount, id: string): Promise<void> {
  const token = await accessTokenFor(account);
  await gmailFetch(token, `messages/${id}/modify`, { method: "POST", body: JSON.stringify({ removeLabelIds: ["UNREAD"] }) });
}

export interface SendOptions {
  to: string;
  subject: string;
  body: string;
  /** When replying: the original message's id, so the reply lands in the same thread. */
  replyToId?: string;
}

export async function sendEmail(account: GoogleAccount, opts: SendOptions): Promise<string> {
  const token = await accessTokenFor(account);
  let threadId: string | undefined;
  const headers = [`From: ${account.email}`, `To: ${opts.to}`, `Subject: ${opts.subject}`, "MIME-Version: 1.0", 'Content-Type: text/plain; charset="UTF-8"'];
  if (opts.replyToId) {
    const original = await readEmail(account, opts.replyToId);
    threadId = original.threadId;
    if (original.messageIdHeader) {
      headers.push(`In-Reply-To: ${original.messageIdHeader}`);
      headers.push(`References: ${[original.references, original.messageIdHeader].filter(Boolean).join(" ")}`);
    }
  }
  const raw = Buffer.from(`${headers.join("\r\n")}\r\n\r\n${opts.body}`)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const sent = await gmailFetch<{ id: string }>(token, "messages/send", {
    method: "POST",
    body: JSON.stringify(threadId ? { raw, threadId } : { raw }),
  });
  return sent.id;
}
