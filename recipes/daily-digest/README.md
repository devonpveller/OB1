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

### Morning routine: one idempotent action (mr-routine-outage, round 3)

Every caller uses ONE action, `ensureToday()` in `src/routine/routine.ts`:
`openbrain-cron` (05:00 UTC = 01:00 EDT) POSTs `openbrain-digest /routine/start`, the L14
whole-chain trigger (and any on-demand button) POSTs `/routine/ensure`, the podcast POSTs
`/run` when it ends, and the digest's own timer calls it at the send-by deadline
(`ROUTINE_SEND_BY`, 07:00), 15 min later, and every `ROUTINE_RECHECK_MIN` (10). All times are
LOCAL in `ROUTINE_TZ` (America/New_York); the containers run UTC.

Today is ONE record, `D:\_data\routine\<date>.day.json`, in one of four states:

| State | What `ensureToday()` does |
|---|---|
| NOT STARTED | checks dependencies - the model (gateway `/health/liveliness` + one 1-token probe, never LiteLLM `/health`), the research engine (`/health` model state), Gmail auth - then starts the chain (gmail-pull -> prune -> podcast -> `/run`). A down dependency is handed to its owner (one post per dependency per day in #sysadmin, `src/routine/owner.ts`) and re-checked with backoff for `ROUTINE_DEP_WAIT_MIN` (60); still down -> FAILED with the reason. |
| IN PROGRESS | verifies activity: the record's heartbeat, the podcast run's heartbeat, gmail-pull / prune / podcast `/health`. Nothing running and no heartbeat for `ROUTINE_STALE_MIN` (15) -> FAILED with the reason. An unreadable `/health` is UNKNOWN, never FAILED by itself. |
| DONE | the digest is out and nothing is owed; with the Sent-folder check enabled it is confirmed in Gmail's Sent folder. Nothing else. |
| FAILED | checks dependencies; all up -> retries the chain (at most `ROUTINE_MAX_CHAIN_ATTEMPTS`, 3, at least 10 min apart, never after `ROUTINE_FOLLOWUP_CUTOFF`, 20:00). A check that finds something down uses no attempt. |

Delivery is part of the same action:
- **Digest** when the chain has ended, or at 07:00 with whatever is ready - never waiting on a
  model probe. Unfinished sections are shown as WAITING FOR THE MODEL / STILL RUNNING / FAILED /
  STATUS UNKNOWN, with whether a follow-up can still come. A definite failure (connect refused,
  Gmail error answer) is retried every 10 min until the cutoff.
- **Unknown outcome** (the request may have reached Gmail, no answer): every mail carries
  `X-OpenBrain-Digest: <date>;<kind>`; the routine reads Gmail's Sent folder - found = sent, not
  found = send again, check unavailable = stays unknown (no resend; the alert says so).
  **The check is OFF by default**: the deployed digest token has `gmail.send` only. To enable it,
  re-consent with `deno run -A setup-token.ts --with-sent-check` (adds `gmail.metadata`, headers
  only) and set `SENT_CHECK_TOKEN_PATH` to that token in the container.
- **Follow-up**: ONE short email when a section that was pending at send time is ready.
- **Alert**: ONE Telegram message (sysadmin out-of-band bot, `SYSADMIN_TELEGRAM_BOT_TOKEN` /
  `_CHAT_ID` in `OB1/docker/.env`; blank = logged only) from 07:15 if the digest is not out or the
  podcast not produced; re-sent at later passes until the cutoff only if Telegram did not confirm
  it. Step names, counts, states and times only.

**The chain's gmail-pull body (round 5).** A start that carries a JSON body (the cron line,
an L14 call with a body) sends that body, and the day's retries and resumed waits reuse it.
Every other start - the `ROUTINE_CHAIN_START` timer, boot, a FAILED retry, an ad-hoc POST with
no or an empty body - sends `CHAIN_HEAD_BODY` (default the cron body:
`{"labelsPrefix":"brain/","window":"90d","limit":500}`), never `{}` (which gmail-pull reads as
"its CLI defaults": SENT mail, 24 h, 50). `CHAIN_HEAD_BODY={}` is the explicit opt-in to that.

**First boot / unreadable record (round 5).** With no record for today and an
`openbrain-digest-<ISO>.md` audit copy dated today (local) under the reports dir - today's digest
was already produced, e.g. by the pre-routine code - the record is seeded DONE / sent and nothing
is sent. A `<date>.day.json` that exists but cannot be read fails closed: no chain start, no
send, one logged line, `/routine/*` answer 503; the file is left as it is.

There are no claim files and no force switch. To re-open a day by hand, stop openbrain-digest,
edit `D:\_data\routine\<date>.day.json` (deleting it re-opens the day only when no digest audit
copy is dated today - see first boot), start it again. State for today:
`GET http://openbrain-digest:8080/health` -> `routine`.

**Podcast restart.** The run lock is in memory plus a run record with a heartbeat
(`<date>.podcast.json`); after a restart mid-run the run is closed as interrupted and resumed ONCE.
Runs are killed after `PODCAST_RUN_MAX_MS` (16 h).
