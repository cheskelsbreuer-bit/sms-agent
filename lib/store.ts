/**
 * Tiny JSON storage on Vercel Blob (private). One user, a handful of small files.
 *
 *   state/conversation.json  recent chat history
 *   state/notes.json         saved notes
 *   state/reminders.json     reminders (scheduled through Twilio)
 *   state/pending.json       the rest of a long reply, sent when the owner texts "more"
 */
import { get, put } from "@vercel/blob";

export interface ChatTurn {
  role: "user" | "assistant";
  text: string;
  at: string; // ISO timestamp
}

export interface Note {
  id: string;
  text: string;
  createdAt: string;
}

export interface Reminder {
  id: string;
  text: string;
  /** When the reminder should arrive, ISO 8601 with offset. */
  sendAt: string;
  /** Twilio message SID once scheduled with Twilio (SM...). Empty until then. */
  twilioSid: string;
  createdAt: string;
  status: "scheduled" | "waiting" | "sent" | "canceled";
}

export interface PendingReply {
  chunks: string[];
  createdAt: string;
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    const result = await get(path, { access: "private", useCache: false });
    if (!result || result.statusCode !== 200) return fallback;
    const text = await new Response(result.stream).text();
    return JSON.parse(text) as T;
  } catch (err) {
    // Missing blob or empty store: start fresh rather than crash.
    console.warn(`store: could not read ${path}:`, (err as Error).message);
    return fallback;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await put(path, JSON.stringify(value, null, 2), {
    access: "private",
    contentType: "application/json",
    addRandomSuffix: false,
    allowOverwrite: true,
    cacheControlMaxAge: 0,
  });
}

export const store = {
  conversation: {
    load: () => readJson<ChatTurn[]>("state/conversation.json", []),
    save: (turns: ChatTurn[]) => writeJson("state/conversation.json", turns),
  },
  notes: {
    load: () => readJson<Note[]>("state/notes.json", []),
    save: (notes: Note[]) => writeJson("state/notes.json", notes),
  },
  reminders: {
    load: () => readJson<Reminder[]>("state/reminders.json", []),
    save: (reminders: Reminder[]) => writeJson("state/reminders.json", reminders),
  },
  pending: {
    load: () => readJson<PendingReply | null>("state/pending.json", null),
    save: (pending: PendingReply | null) => writeJson("state/pending.json", pending),
  },
};

export function newId(): string {
  return Math.random().toString(36).slice(2, 8);
}
