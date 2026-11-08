/**
 * The things the assistant can DO: notes and reminders.
 * Web search is a server-side tool and is declared in agent.ts.
 */
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { config } from "./config.js";
import { newId, store, type Reminder } from "./store.js";
import { SCHEDULE_MAX_MS, SCHEDULE_MIN_MS, cancelScheduledSms, scheduleSms } from "./twilio.js";

export function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    timeZone: config.timezone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

// ---------- Notes ----------

export const saveNote = betaZodTool({
  name: "save_note",
  description:
    "Save a note for the owner so it can be found later. Use when they say things like 'remember that...', 'note:', 'save this', or share something they will want back later.",
  inputSchema: z.object({
    text: z.string().describe("The note text, cleaned up but keeping the owner's meaning."),
  }),
  run: async ({ text }) => {
    const notes = await store.notes.load();
    const note = { id: newId(), text, createdAt: new Date().toISOString() };
    notes.push(note);
    await store.notes.save(notes);
    return `Saved note #${note.id}.`;
  },
});

export const listNotes = betaZodTool({
  name: "list_notes",
  description:
    "List or search the owner's saved notes. Call with no query to see everything, or with a query to find matching notes.",
  inputSchema: z.object({
    query: z.string().optional().describe("Optional words to search for (case-insensitive)."),
  }),
  run: async ({ query }) => {
    const notes = await store.notes.load();
    const q = query?.trim().toLowerCase();
    const hits = q ? notes.filter((n) => n.text.toLowerCase().includes(q)) : notes;
    if (hits.length === 0) return q ? `No notes match "${query}".` : "No notes saved yet.";
    return hits
      .map((n) => `#${n.id} (${formatWhen(n.createdAt)}): ${n.text}`)
      .join("\n");
  },
});

export const deleteNote = betaZodTool({
  name: "delete_note",
  description: "Delete a saved note by its id (the short code after #). Use list_notes first if you don't know the id.",
  inputSchema: z.object({
    id: z.string().describe("The note id, e.g. 'k3x9a2'."),
  }),
  run: async ({ id }) => {
    const notes = await store.notes.load();
    const idx = notes.findIndex((n) => n.id === id.replace(/^#/, ""));
    if (idx === -1) return `No note with id ${id}.`;
    const [removed] = notes.splice(idx, 1);
    await store.notes.save(notes);
    return `Deleted note #${removed.id}: ${removed.text}`;
  },
});

// ---------- Reminders ----------

/**
 * Store a reminder and, when it falls inside Twilio's 15-minute-to-35-day window, schedule it with Twilio.
 * Reminders further out are marked "waiting"; the daily cron schedules them once they come into range.
 */
export async function scheduleReminder(text: string, sendAt: Date): Promise<Reminder> {
  const reminders = await store.reminders.load();
  const reminder: Reminder = {
    id: newId(),
    text,
    sendAt: sendAt.toISOString(),
    twilioSid: "",
    createdAt: new Date().toISOString(),
    status: "waiting",
  };
  const lead = sendAt.getTime() - Date.now();
  if (lead <= SCHEDULE_MAX_MS) {
    reminder.twilioSid = await scheduleSms(`Reminder: ${text}`, sendAt);
    reminder.status = "scheduled";
  }
  reminders.push(reminder);
  await store.reminders.save(reminders);
  return reminder;
}

export const setReminder = betaZodTool({
  name: "set_reminder",
  description:
    "Schedule a text-message reminder to the owner at a specific date and time. Work out the exact time from the current date/time given in the system prompt (e.g. 'tomorrow at 9' means tomorrow 9:00 AM in the owner's timezone). Reminders must be at least 15 minutes in the future; if the owner asks for sooner, schedule it for 15 minutes from now and tell them.",
  inputSchema: z.object({
    text: z.string().describe("What to remind them about, as a short message. No 'Reminder:' prefix; that is added automatically."),
    sendAt: z
      .string()
      .describe("When to send it, ISO 8601 with timezone offset, e.g. 2026-11-09T09:00:00-05:00."),
  }),
  run: async ({ text, sendAt }) => {
    const when = new Date(sendAt);
    if (Number.isNaN(when.getTime())) return `Could not understand the time "${sendAt}". Use ISO 8601 with an offset.`;
    const minAllowed = new Date(Date.now() + SCHEDULE_MIN_MS);
    const actual = when < minAllowed ? minAllowed : when;
    const reminder = await scheduleReminder(text, actual);
    const note = when < minAllowed ? " (moved to the earliest allowed time, about 15 minutes from now)" : "";
    return `Reminder #${reminder.id} set for ${formatWhen(reminder.sendAt)}${note}.`;
  },
});

export const listReminders = betaZodTool({
  name: "list_reminders",
  description: "List the owner's upcoming reminders with their ids and times.",
  inputSchema: z.object({}),
  run: async () => {
    const reminders = (await store.reminders.load())
      .filter((r) => r.status === "scheduled" || r.status === "waiting")
      .filter((r) => new Date(r.sendAt).getTime() > Date.now() - 60_000)
      .sort((a, b) => a.sendAt.localeCompare(b.sendAt));
    if (reminders.length === 0) return "No upcoming reminders.";
    return reminders.map((r) => `#${r.id} ${formatWhen(r.sendAt)}: ${r.text}`).join("\n");
  },
});

export const cancelReminder = betaZodTool({
  name: "cancel_reminder",
  description: "Cancel an upcoming reminder by id. Use list_reminders first if you don't know the id.",
  inputSchema: z.object({
    id: z.string().describe("The reminder id, e.g. 'p7q2m1'."),
  }),
  run: async ({ id }) => {
    const reminders = await store.reminders.load();
    const reminder = reminders.find((r) => r.id === id.replace(/^#/, ""));
    if (!reminder) return `No reminder with id ${id}.`;
    if (reminder.status === "canceled" || reminder.status === "sent") return `Reminder #${reminder.id} is already ${reminder.status}.`;
    if (reminder.twilioSid) {
      try {
        await cancelScheduledSms(reminder.twilioSid);
      } catch (err) {
        return `Could not cancel with Twilio (it may be about to send): ${(err as Error).message}`;
      }
    }
    reminder.status = "canceled";
    await store.reminders.save(reminders);
    return `Canceled reminder #${reminder.id} (${formatWhen(reminder.sendAt)}: ${reminder.text}).`;
  },
});

export const customTools = [saveNote, listNotes, deleteNote, setReminder, listReminders, cancelReminder];
