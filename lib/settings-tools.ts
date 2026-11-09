import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { config } from "./config.js";
import { describeSettings, isValidTimezone, saveSettings, type ModelKey, type ReplyLength } from "./settings.js";

export const updateSettings = betaZodTool({
  name: "update_settings",
  description:
    "Change one or more of the owner's settings. timezone: IANA name like Asia/Jerusalem or America/New_York (use when he travels or times look off). model: 'opus' (Claude Opus 5.5, smartest, default) or 'sonnet' (Claude Sonnet 5.5, faster and cheaper). replyLength: 'short' or 'normal'. Only pass the fields he asked to change.",
  inputSchema: z.object({
    timezone: z.string().optional(),
    model: z.enum(["opus", "sonnet"]).optional(),
    replyLength: z.enum(["short", "normal"]).optional(),
  }),
  run: async ({ timezone, model, replyLength }) => {
    if (timezone && !isValidTimezone(timezone)) return `"${timezone}" is not a valid timezone name. Try something like Asia/Jerusalem or America/New_York.`;
    const patch: { timezone?: string; model?: ModelKey; replyLength?: ReplyLength } = {};
    if (timezone) patch.timezone = timezone;
    if (model) patch.model = model;
    if (replyLength) patch.replyLength = replyLength;
    if (Object.keys(patch).length === 0) return "Nothing to change.";
    await saveSettings(patch);
    return `Updated.\n${describeSettings(config.timezone, config.modelKey, config.replyLength)}`;
  },
});

export const settingsTools = [updateSettings];
