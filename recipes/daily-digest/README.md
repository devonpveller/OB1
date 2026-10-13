# Daily Digest

> Automated daily summary of your recent thoughts, delivered to your inbox.

## What It Does

Queries your most recent Open Brain thoughts, groups them by type and topic, and delivers a formatted summary. You wake up to a digest of everything your brain captured yesterday.

There are two approaches — pick the one that fits your setup:

| Approach | Infrastructure | Difficulty | Auto-send? |
| -------- | -------------- | ---------- | ---------- |
| **Claude Code Scheduled Task** (below) | None — uses MCP tools you already have | Beginner | Draft only (one-tap send) |
| **Supabase Edge Function** (planned) | Edge Function + pg_cron + email service | Intermediate | Full auto-send |

---

## Approach A: Claude Code Scheduled Task

Zero-infrastructure variant. If you already run Claude Code (or Claude Desktop's Code mode) with Open Brain MCP and Gmail MCP connected, this works today with no deployment.

### Prerequisites

- Working Open Brain setup ([guide](../../docs/01-getting-started.md))
- Claude Code or Claude Desktop (Code mode) with:
  - Open Brain MCP connected
  - Gmail MCP connected (for email delivery)

### How It Works

Claude Code has built-in scheduled tasks (visible in Claude Desktop under the **Scheduled** tab). You install a skill file — a prompt template — that tells Claude what to do on each run:

1. Query Open Brain for thoughts from the last 24 hours
2. Organize them into a scannable digest (grouped by type, with topic/people tags)
3. Create a Gmail draft addressed to you

Claude *is* the LLM — no OpenRouter key needed.

### Steps

![Step 1](https://img.shields.io/badge/Step_1-Install_the_Skill_File-1E88E5?style=for-the-badge)

Copy the skill template into your Claude scheduled tasks directory:

```bash
mkdir -p ~/.claude/scheduled-tasks/daily-digest
cp recipes/daily-digest/daily-digest-skill.md ~/.claude/scheduled-tasks/daily-digest/SKILL.md
```

Then open the file and replace `YOUR_EMAIL@example.com` with your actual email address.

> [!IMPORTANT]
> The skill file is a local prompt — it never gets committed to any repo. Your email stays on your machine.

---

![Step 2](https://img.shields.io/badge/Step_2-Create_the_Scheduled_Task-1E88E5?style=for-the-badge)

In any Claude Code session (or Claude Desktop Code mode), run:

```
/schedule
```

Or create it directly by telling Claude:

> "Create a scheduled task called daily-digest that runs every day at 7am using the skill file at ~/.claude/scheduled-tasks/daily-digest/SKILL.md"

The task will appear in Claude Desktop's **Scheduled** tab.

---

![Step 3](https://img.shields.io/badge/Step_3-Test_Run_and_Approve_Tools-1E88E5?style=for-the-badge)

Click **"Run now"** from the Scheduled tab to do an initial test. On the first run, Claude will ask for permission to use the Open Brain and Gmail MCP tools. Approve them once — future runs will remember.

> [!TIP]
> If you haven't captured any thoughts recently, the digest will say so. Capture a few test thoughts first via `capture_thought` to see the full format.

---

### Expected Outcome

Every morning, a Gmail draft appears in your inbox with:

- A count of thoughts captured in the last 24 hours
- Breakdown by type (observations, tasks, ideas, references, person notes)
- Each thought's content (truncated), source, and topic/people tags
- A summary header with top themes

You review the draft and hit send (or just read it).

### Troubleshooting

**Issue: Scheduled task never fires**
Solution: Claude Code must be running (or Claude Desktop must be open) at the scheduled time. If your machine was asleep, the task fires on next launch.

**Issue: Task pauses waiting for permissions**
Solution: Run it manually once via the Scheduled tab and approve the MCP tool permissions. They persist for future runs.

**Issue: "No thoughts found" every day**
Solution: Check that your Open Brain MCP is connected and has recent data. Run `list_thoughts` manually in a Claude Code session to verify.

**Issue: Gmail draft not appearing**
Solution: Verify your Gmail MCP connector is working. Try `gmail_create_draft` manually in a Claude session to test.

---

## Approach B: Supabase Edge Function (Planned)

A fully self-contained approach using a Supabase Edge Function, pg_cron trigger, and an email service (Resend or SendGrid) for true automated delivery without Claude running. This approach is not yet implemented — contributions welcome.

### Prerequisites (planned)

- Supabase CLI available ([Homebrew/Scoop/standalone binary or `npx supabase`](https://supabase.com/docs/guides/local-development/cli/getting-started); `npm i -g supabase` is not supported)
- OpenRouter API key (for generating the summary)
- Email service: Resend or SendGrid (free tier)

### Credential Tracker (for future Edge Function approach)

```text
DAILY DIGEST -- CREDENTIAL TRACKER
--------------------------------------

FROM YOUR OPEN BRAIN SETUP
  Supabase Project URL:  ____________
  Supabase Secret key:   ____________
  OpenRouter API key:    ____________

DELIVERY METHOD
  Email service (Resend/SendGrid): ____________
  API key:                         ____________
  Sender email:                    ____________

--------------------------------------
```

---

## Approach C: Self-hosted scheduled container (this fork)

The self-hosted ai-stack ships a server-side variant of Approach B that runs entirely on local infrastructure plus the user's own Gmail. No Supabase cloud, no OpenRouter, no Resend/SendGrid — just a Deno container that queries the local PostgREST proxy, formats a digest, and delivers it as a self-addressed Gmail message.

Components in this directory:

| File | Purpose |
|------|---------|
| [`send-digest.ts`](./send-digest.ts) | The container entrypoint. Mechanical formatting only (no LLM call). |
| [`setup-token.ts`](./setup-token.ts) | One-time OAuth bootstrap. Run on the host before scheduling. |
| [`.env.example`](./.env.example) | Recipient address, time window, PostgREST URL. |

The compose service `openbrain-digest` is defined under profile `scheduled` next to `openbrain-gmail-pull` and `openbrain-gmail-prune` in [`docker/docker-compose.yml`](../../docker/docker-compose.yml). The full design + ordering vs. the gmail pull/prune cycle is in [`docs/google-open-brain/google-open-brain-scheduled-digest.md`](../../docs/google-open-brain/google-open-brain-scheduled-digest.md).

### One-time setup

1. Copy `.env.example` to `.env` and edit `DIGEST_TO` / `DIGEST_FROM` to your Gmail address.
2. Make sure the OAuth client's consent screen (Google Cloud Console) includes the `https://www.googleapis.com/auth/gmail.send` scope, and that your Google account is added as a test user if the app is in testing mode.
3. On the host, from this directory, symlink (or copy) the OAuth client secret you already use for gmail-pull, then bootstrap the token:

   ```powershell
   Copy-Item ..\..\secrets\google\open-brain-email\client_secret_*.json .\credentials.json
   deno run --allow-net --allow-read --allow-write --allow-env setup-token.ts
   ```

4. Move the resulting `token.json` to `secrets/google/openbrain-digest/token.json` so the container can mount it.
5. Trigger a one-off run from PowerShell to verify:

   ```powershell
   docker compose --profile scheduled run --rm openbrain-digest
   ```

   The digest arrives in your Gmail inbox; a copy lands in `D:\_data\openbrain-digest-latest.md` regardless.
6. Add a Windows Task Scheduler trigger that fires daily at your preferred time (mirrors the wrappers for `openbrain-gmail-pull` / `openbrain-gmail-prune`).

### Morning routine: model outages, send-by deadline, send-once (mr-routine-outage)

The chain is `openbrain-cron` (05:00 UTC = 01:00 EDT) -> `openbrain-digest /routine/start` ->
model gate -> `openbrain-gmail-pull` -> prune -> `openbrain-podcast` (link-enrich) ->
`openbrain-digest /run`. All routine times are LOCAL in `ROUTINE_TZ`
(default `America/New_York`); the containers run UTC.

- **Model gate.** Before model work, the chain head, link-enrich (before each model stage)
  and the digest check the model through the gateway: `GET /health/liveliness` plus one
  `max_tokens: 1` chat probe (never LiteLLM `/health`). While it is down they WAIT
  (backoff 30 s doubling to 5 min) instead of running degraded. A research job the engine
  reports `model_down` is resubmitted after the model is back (max 3).
- **Send-by deadline** `ROUTINE_SEND_BY` (07:00): an in-process timer in openbrain-digest
  sends the digest with whatever is ready; a section that is not ready is shown as
  WAITING FOR THE MODEL / STILL RUNNING / FAILED, never left out silently. When it later
  completes, ONE short follow-up email delivers it (until `ROUTINE_FOLLOWUP_CUTOFF`, 20:00,
  the chain stops waiting for the model).
- **Send-once marker.** `D:\_data\routine\<local date>.digest.claim` /
  `.followup.claim` / `.alert.claim`, created exclusively before the send. A re-run of the
  chain the same day sends nothing new. **Force a re-send** explicitly:
  `docker exec openbrain-cron sh -c "curl -fsS -X POST -d '{\"force\":true}' http://openbrain-digest:8080/run"`
  (or delete the claim file). A send that failed DEFINITELY (Gmail answered an error) is
  retried twice and releases the marker; one that MAY have gone out keeps it (no duplicate).
- **Alert.** At deadline + `ROUTINE_ALERT_GRACE_MIN` (15 min), if the digest was not sent or
  the podcast not produced: ONE Telegram message through the sysadmin out-of-band bot
  (`SYSADMIN_TELEGRAM_BOT_TOKEN` / `_CHAT_ID` in `OB1/docker/.env`; blank = logged only).
  Step names, counts and times only.
- **Podcast restart.** The run lock is in memory plus a run record
  (`<date>.podcast.json`); after a restart mid-run the run is closed as interrupted and
  resumed ONCE. Runs are killed after `PODCAST_RUN_MAX_MS` (16 h).
- State for today: `GET http://openbrain-digest:8080/health` -> `routine`.
