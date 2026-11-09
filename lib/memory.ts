/**
 * The memory keeper: after each exchange, a small cheap job writes down what someone who knows
 * Chesky well would remember. Additive only, never shrinks (a lesson from the first twin).
 *
 *   state/learned.json  { facts: [{area, text, at}], corrections: [{text, at}], style: [{text, at}] }
 */
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { get, put } from "@vercel/blob";
import { z } from "zod";
import { config } from "./config.js";

interface Entry {
  text: string;
  at: string;
  area?: string;
}
export interface Learned {
  facts: Entry[];
  corrections: Entry[];
  style: Entry[];
}

const PATH = "state/learned.json";
const EMPTY: Learned = { facts: [], corrections: [], style: [] };

export async function loadLearned(): Promise<Learned> {
  try {
    const result = await get(PATH, { access: "private", useCache: false });
    if (!result || result.statusCode !== 200) return EMPTY;
    const parsed = JSON.parse(await new Response(result.stream).text()) as Partial<Learned>;
    return { facts: parsed.facts ?? [], corrections: parsed.corrections ?? [], style: parsed.style ?? [] };
  } catch {
    return EMPTY;
  }
}

async function saveLearned(learned: Learned): Promise<void> {
  await put(PATH, JSON.stringify(learned, null, 2), {
    access: "private",
    contentType: "application/json",
    addRandomSuffix: false,
    allowOverwrite: true,
    cacheControlMaxAge: 0,
  });
}

/** Text block for the system prompt: what the twin has learned since the export. */
export function learnedText(learned: Learned): string {
  if (!learned.facts.length && !learned.corrections.length && !learned.style.length) return "";
  const lines: string[] = ["=== LEARNED SINCE HE GOT TO ISRAEL (newest last) ==="];
  if (learned.corrections.length) {
    lines.push("CORRECTIONS he gave (these win over anything else):");
    for (const c of learned.corrections.slice(-60)) lines.push(`- ${c.text}`);
  }
  if (learned.facts.length) {
    lines.push("THINGS YOU KNOW:");
    for (const f of learned.facts.slice(-400)) lines.push(`- [${f.area ?? "other"}] ${f.text}`);
  }
  if (learned.style.length) {
    lines.push("HOW HE TALKS NOW:");
    for (const s of learned.style.slice(-40)) lines.push(`- ${s.text}`);
  }
  return lines.join("\n");
}

const KeeperOutput = z.object({
  facts: z.array(
    z.object({
      area: z.enum([
        "thinking", "personality", "opinions", "values", "humor", "decisions", "reactions", "family", "work", "money",
        "beliefs", "community", "relationships", "health", "daily", "likes", "dislikes", "fears", "stories", "yeshiva", "other",
      ]),
      text: z.string(),
    }),
  ),
  corrections: z.array(z.string()),
  style: z.array(z.string()),
});

const KEEPER_SYSTEM = `You keep the memory for a project where a program is learning to be Chesky, a 17-year-old Hasidic guy from Monsey now learning in yeshiva in Israel, who talks to it by SMS. You read one exchange and write down only what someone who knows him well would actually remember. Answer only with the JSON you were asked for.
Rules:
- Be picky. Most exchanges yield zero or one fact. Errands (look up the weather, set a reminder, read my email) usually yield nothing. One true note about who he is beats five details about his afternoon.
- Personality first: how he reacts, what he values, his opinions, his temperament, humor, how he decides, how he treats people. Best of all is a pattern of thought, area "thinking": "When X, he does Y, because Z."
- Area "yeshiva" is for his life in Israel now: schedule, chavrusa, people, how it's going.
- Only what Chesky himself said or clearly confirmed. The twin's lines are never facts about him.
- Facts are short, concrete, third person, with names and specifics. Never record anything about this app, SMS, the model, settings, reminders, or how he reacted to the twin itself.
- corrections: things he said the twin got wrong about him, written as the corrected truth, including "I wouldn't say that" and "I don't think like that". Only when he actually corrected something.
- style: how he talks, in his own voice, at most two, only if genuinely new.
- When nothing is worth keeping, return empty arrays.`;

let client: Anthropic | null = null;

/** Run after the reply is sent. Never throws; failures are logged and skipped. */
export async function learnFromExchange(userText: string, reply: string): Promise<void> {
  try {
    // Skip obvious errands and tiny acknowledgements to save the call.
    if (userText.trim().length < 12 || /^(more|next|continue|ok|okay|yes|no|thanks|thank you|help|settings)\.?$/i.test(userText.trim())) return;
    if (!client) client = new Anthropic({ apiKey: config.anthropicApiKey });
    const response = await client.messages.parse({
      model: config.memoryModel,
      max_tokens: 1500,
      output_config: { format: zodOutputFormat(KeeperOutput), effort: "low" },
      system: KEEPER_SYSTEM,
      messages: [{ role: "user", content: `CHESKY: ${userText}\nTWIN: ${reply}` }],
    });
    const out = response.parsed_output;
    if (!out) return;
    if (!out.facts.length && !out.corrections.length && !out.style.length) return;
    const learned = await loadLearned();
    const at = new Date().toISOString();
    const known = new Set(learned.facts.map((f) => f.text.toLowerCase()));
    for (const f of out.facts) if (!known.has(f.text.toLowerCase())) learned.facts.push({ area: f.area, text: f.text, at });
    for (const c of out.corrections) learned.corrections.push({ text: c, at });
    for (const s of out.style) learned.style.push({ text: s, at });
    await saveLearned(learned);
  } catch (err) {
    console.warn("memory keeper skipped:", (err as Error).message);
  }
}
