# SMS Assistant

A personal AI assistant you talk to by plain text message. Twilio receives your texts, a small app on Vercel asks Claude what to do, and the answer is texted back. It only answers one phone number (yours).

What it does today:
- Answers questions, with web search when needed
- Saves notes and finds them again ("remember that...", "what did I note about...")
- Sets, lists, and cancels text-message reminders ("remind me Thursday 9am to call the bank")
- Text `help` for a short list; text `more` to get the rest of a long answer

## One-time setup

### 1. Collect four values (do not paste them into chat; they go straight into Vercel)

| Value | Where to find it |
|---|---|
| Twilio Account SID (starts with `AC`) | twilio.com/console, home page, "Account Info" box |
| Twilio Auth Token | Same box, click the eye icon to reveal |
| Twilio Messaging Service SID (starts with `MG`) | twilio.com/console → Messaging → Services → click your service → SID at the top |
| Anthropic API key (starts with `sk-ant-`) | console.anthropic.com → API Keys → Create Key |

Your Twilio phone number: twilio.com/console → Phone Numbers → Manage → Active Numbers.

### 2. Deploy to Vercel

1. vercel.com → Add New → Project → import this GitHub repository. Leave settings as detected. Deploy.
2. Project → Storage → Create Database → Blob → create and connect to the project (this adds `BLOB_READ_WRITE_TOKEN` automatically).
3. Project → Settings → Environment Variables → add:

| Name | Value |
|---|---|
| `ANTHROPIC_API_KEY` | from step 1 |
| `TWILIO_ACCOUNT_SID` | from step 1 |
| `TWILIO_AUTH_TOKEN` | from step 1 |
| `TWILIO_MESSAGING_SERVICE_SID` | from step 1 |
| `MY_PHONE` | your cell, e.g. `+18455888833` |
| `TIMEZONE` | e.g. `America/New_York` |
| `CRON_SECRET` | any long random string |
| `OWNER_NAME` | optional, your first name |

4. Deployments → ⋯ on the latest → Redeploy (so the new variables are picked up).
5. Note your project URL, e.g. `https://sms-agent-xxxx.vercel.app`. Opening `/api/sms` in a browser should say "SMS assistant is running."

### 3. Point Twilio at it

twilio.com/console → Messaging → Services → your service → Integration:
- Choose "Send a webhook"
- Request URL: `https://YOUR-PROJECT.vercel.app/api/sms`, method `HTTP POST`
- Save

Also make sure your Twilio phone number is in that service's Sender Pool (Messaging → Services → your service → Sender Pool).

### 4. Test

Text `help` to your Twilio number. You should get a reply within a few seconds.

## How it works

```
api/sms.ts    Twilio webhook: verifies signature, checks it's you, replies to Twilio at once,
              then runs the assistant in the background and texts the answer
lib/agent.ts  One conversation turn with Claude (tool loop, system prompt, memory)
lib/tools.ts  Notes and reminders
lib/twilio.ts Sending, scheduling, and splitting long texts
lib/store.ts  Small JSON files in Vercel Blob (history, notes, reminders)
api/cron.ts   Daily: schedules reminders that were more than 35 days out
```

Reminders use Twilio's built-in message scheduling, so they go out even if the app is idle. Twilio needs at least 15 minutes' notice.

## Costs

- Twilio: about 1¢ per text each way (a long reply counts as several segments)
- Claude API: pay per use; typical texts cost a fraction of a cent to a few cents
- Vercel Hobby plan and Blob storage: free at this scale
