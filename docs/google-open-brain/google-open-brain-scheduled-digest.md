# Open Brain → Gmail — Scheduled Digest (design)

**Status:** Implemented (2026-05-26). Container, OAuth bootstrap, and
audit-trail reports are in place. Windows Task Scheduler trigger is the
remaining manual step (owner: user, parallels the existing pull/prune
wrappers).

## Purpose

Close the loop on the Gmail → Open Brain pipeline. The pull job
(`openbrain-gmail-pull`) ingests labeled mail into `thoughts`; the prune
job (`openbrain-gmail-prune`) ages out short-term holds; the digest job
(`openbrain-digest`) emails a morning summary of yesterday's activity to
the operator. The brain stops being a write-only sink — the operator
sees what landed without searching.

## Locked decisions

1. **Server-side scheduled container.** Mirrors the pull/prune pattern.
   Profile `scheduled`, runs via `docker compose run --rm
   openbrain-digest`, fired by Windows Task Scheduler. Independent of
   any AI client being open.
2. **Mechanical formatting, no LLM call.** Group by `metadata.type`,
   show counts and the first ~160 chars of each thought. The whole
   point of a digest is determinism — a local LLM summary adds latency
   and noise without changing what the operator needs to see.
3. **Daily ordering.** Pull (01:00) → prune (01:30) → wiki recompile
   (triggered by prune) → **digest (07:00 local)**. The digest reads a
   24h window so it captures everything pull deposited overnight, after
   prune has aged out anything destined to leave.
4. **Self-addressed Gmail delivery.** Uses the user's own Gmail OAuth
   client (the same one as pull/prune) with a separate token that has
   the `gmail.send` scope. From-and-To are the same address; the
   message lands in Inbox like any other mail and is searchable
   alongside the source emails.
5. **Audit trail on disk regardless of email outcome.** Every run writes
   `D:\_data\openbrain-digest-latest.md` (overwritten) plus a dated
   archive `D:\_data\openbrain-digest-<ts>.md`. If Gmail send fails
   (token expired, network blip, scope revoked), the digest is still
   readable. Mirrors how the pull container handles its morning
   reports.
6. **Separate OAuth token, shared OAuth client.** Same OAuth client
   (one app in Google Cloud), two separate consent flows: pull's
   `token.json` carries `gmail.readonly`; digest's `token.json` carries
   `gmail.send`. No risk of one job accidentally consuming the other's
   scope. The client_secret_*.json is mounted from the existing
   `secrets/google/open-brain-email/` directory for both.
7. **No new network attachment.** Digest is on `obnet` only — it needs
   to talk to `openbrain-rest` (PostgREST) and to Gmail (egress on the
   default bridge). It does NOT join `llm-net` because there is no LLM
   call.
8. **No host port published.** The container has no listener; it runs,
   sends, exits. Nothing for the recovery scripts to babysit.

## Components

| File / service | Role |
|----------------|------|
| `OB1/recipes/daily-digest/send-digest.ts` | The container entrypoint. PostgREST query → group → format → Gmail send → disk write. |
| `OB1/recipes/daily-digest/setup-token.ts` | One-time OAuth bootstrap. Run on the host once; produces `token.json` with `gmail.send` scope. |
| `OB1/recipes/daily-digest/.env` | `DIGEST_TO`, `DIGEST_FROM`, `DIGEST_WINDOW_HOURS`, `DIGEST_LIMIT`, `OPEN_BRAIN_URL`. |
| `openbrain-digest` (compose service) | Defined under `profiles: ["scheduled"]` next to `openbrain-gmail-pull`. |
| `secrets/google/openbrain-digest/token.json` | The dedicated `gmail.send` token. Created by `setup-token.ts`. |
| `D:\_data\openbrain-digest-latest.md` + archives | Audit trail. |

## OAuth scope upgrade

The gmail-pull OAuth client is configured for `gmail.readonly`. To enable
digest send the OAuth consent screen must also list
`https://www.googleapis.com/auth/gmail.send`. Steps (one-time, in Google
Cloud Console):

1. Open the OAuth client used by `openbrain-gmail-pull` (the one whose
   `client_secret_*.json` is in `secrets/google/open-brain-email/`).
2. Edit the consent screen → Scopes → add
   `https://www.googleapis.com/auth/gmail.send`.
3. If the app is in testing mode, confirm your Gmail address is in the
   test-user list. Otherwise Google requires verification, which is not
   needed for personal/internal use.
4. Run `setup-token.ts` from the recipe directory; the browser-based
   consent grants the new scope and a token.json is written.

`gmail.readonly` (pull/prune) and `gmail.send` (digest) are independent
grants. Adding the send scope does not affect the existing pull token.

## Windows Task Scheduler wrapper

Pattern matches the pull/prune wrappers. Suggested trigger:

```
Trigger:   Daily at 07:00 local
Action:    powershell.exe
Arguments: -NoProfile -Command "docker compose -f 'd:\Open WebUI\ai-stack\OB1\docker\docker-compose.yml' --profile scheduled run --rm openbrain-digest *>&1 | Tee-Object 'D:\_data\openbrain-digest-<date>.log'"
```

Log capture exists primarily for diagnosis; the canonical artifact is
`D:\_data\openbrain-digest-latest.md`, written by the script itself
inside the container. If Tee-Object silently breaks again (it did once
for pull), the markdown report is still there.

## Failure modes and recoveries

| Symptom | Likely cause | Recovery |
|---------|--------------|----------|
| Container exits 1, log says "No token.json" | First run, OAuth never bootstrapped | Run `setup-token.ts` on the host; place result at `secrets/google/openbrain-digest/token.json`. |
| Container exits 1, log says "Gmail send failed: 403 insufficient permissions" | OAuth client scope still missing `gmail.send` | Add scope in Google Cloud Console; re-run `setup-token.ts`. |
| Container exits 1, log says "PostgREST query failed" | `openbrain-rest` down or `obnet` broken | Run `scripts/emergency-recovery.ps1 recover`. |
| Digest is empty every day, brain is not empty | Wrong window, or `metadata.type` not populated | Check `OPEN_BRAIN_URL` reachable from inside `obnet`. For type backfill, run the [`source-filtering` backfill](../../recipes/source-filtering/). |
| Email never arrives | Send returned 200 but Gmail filtered it | Check Gmail "All Mail" — self-sent automated mail occasionally lands in a non-Inbox label. Add an inbox filter for `subject:"Open Brain Daily Digest"`. |
