/**
 * Settings the owner can change by texting (timezone when travelling, which model, reply length).
 * Loaded once at the start of each turn; config reads from here first.
 */
import { get, put } from "@vercel/blob";

export const MODELS = {
  opus: "claude-opus-5-5",
  sonnet: "claude-sonnet-5-5",
} as const;
export type ModelKey = keyof typeof MODELS;
export type ReplyLength = "short" | "normal";

export interface Settings {
  timezone?: string;
  model?: ModelKey;
  replyLength?: ReplyLength;
}

let cache: Settings | null = null;

export async function loadSettings(): Promise<Settings> {
  try {
    const result = await get("state/settings.json", { access: "private", useCache: false });
    cache = result && result.statusCode === 200 ? (JSON.parse(await new Response(result.stream).text()) as Settings) : {};
  } catch {
    cache = {};
  }
  return cache;
}

export function currentSettings(): Settings {
  return cache ?? {};
}

export async function saveSettings(patch: Settings): Promise<Settings> {
  const next = { ...(cache ?? (await loadSettings())), ...patch };
  await put("state/settings.json", JSON.stringify(next, null, 2), {
    access: "private",
    contentType: "application/json",
    addRandomSuffix: false,
    allowOverwrite: true,
    cacheControlMaxAge: 0,
  });
  cache = next;
  return next;
}

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** One-line description for the "settings" text command and the system prompt. */
export function describeSettings(timezone: string, modelKey: ModelKey, replyLength: ReplyLength): string {
  const now = new Date().toLocaleString("en-US", { timeZone: timezone, hour: "numeric", minute: "2-digit", timeZoneName: "short" });
  const modelName = modelKey === "opus" ? "Opus 5.5" : "Sonnet 5.5";
  return `Settings\nTimezone: ${timezone} (now ${now})\nModel: ${modelName}\nReplies: ${replyLength}\n\nTo change, just say it: "switch to sonnet", "timezone New York", "shorter replies".`;
}
