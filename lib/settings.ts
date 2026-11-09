/**
 * Small settings the owner can change by texting (e.g. timezone when travelling).
 * Loaded once at the start of each turn; config.timezone reads from here first.
 */
import { get, put } from "@vercel/blob";

export interface Settings {
  timezone?: string;
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
