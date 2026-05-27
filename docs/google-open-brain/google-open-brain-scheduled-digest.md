# Open Brain → Gmail — Scheduled Digest (design)

**Status:** Implemented (2026-05-27). Container, OAuth bootstrap,
audit-trail reports, and HTTP-trigger wiring are in place. Trigger
mechanism is the openbrain-cron container; no Windows Task Scheduler
entry needed. Pull → prune → digest cascades via `NEXT_TRIGGER_URL`,
so digest fires automatically after every successful pull.

## Purpose

Close the loop on the Gmail → Open Brain pipeline. The pull job
(`openbrain-gmail-pull`) ingests labeled mail into `thoughts`; the prune
job (`openbrain-gmail-prune`) ages out short-term holds; the digest job
(`openbrain-digest`) emails a morning summary of yesterday's activity to
the operator. The brain stops being a write-only sink — the operator
sees what landed without searching.

## Locked decisions

1. **Long-running HTTP-triggered container.** Exposes `POST /run` on
   `obnet:8080`. openbrain-cron fires the start of the chain
   (gmail-pull) at 01:00; pull and prune cascade through
   `NEXT_TRIGGER_URL` env vars to fire digest on completion. Independent
   of any AI client being open. (Earlier draft used `profile: scheduled`
   one-shot containers + Windows Task Scheduler — superseded 2026-05-27.)
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

## Trigger wiring (cron-based, event-chained)

The digest is the END of the email pipeline chain. Schedule lives in
`OB1/docker/cron/crontab` (single line: pull at 01:00). The cascade is:

```
openbrain-cron  (01:00)
   │  POST /run
   ▼
openbrain-gmail-pull
   │  on success, POST $NEXT_TRIGGER_URL
   ▼
openbrain-gmail-prune
   │  on success, POST $NEXT_TRIGGER_URL  (+ separately, wiki recompile)
   ▼
openbrain-digest
   │  end of chain
```

`NEXT_TRIGGER_URL` for each service is declared in
`OB1/docker/docker-compose.scheduled.yml`:
- pull: `http://openbrain-gmail-prune:8080/run`
- prune: `http://openbrain-digest:8080/run`
- digest: (unset)

If any step fails, the chain stops; the absence of the morning digest
signals an upstream problem.

To change digest timing relative to the pull (e.g. run digest twice
daily): add a second cron line pointing at `openbrain-digest:8080/run`
directly. Concurrent-run protection (HTTP 409) prevents overlap.

Log capture: the canonical artifact is `D:\_data\openbrain-digest-latest.md`
plus a dated archive, written inside the container regardless of email
delivery outcome. Container stdout/stderr are available via
`docker logs openbrain-digest` for the live HTTP-server tail.

## Failure modes and recoveries

| Symptom | Likely cause | Recovery |
|---------|--------------|----------|
| Container exits 1, log says "No token.json" | First run, OAuth never bootstrapped | Run `setup-token.ts` on the host; place result at `secrets/google/openbrain-digest/token.json`. |
| Container exits 1, log says "Gmail send failed: 403 insufficient permissions" | OAuth client scope still missing `gmail.send` | Add scope in Google Cloud Console; re-run `setup-token.ts`. |
| Container exits 1, log says "PostgREST query failed" | `openbrain-rest` down or `obnet` broken | Run `scripts/emergency-recovery.ps1 recover`. |
| Digest is empty every day, brain is not empty | Wrong window, or `metadata.type` not populated | Check `OPEN_BRAIN_URL` reachable from inside `obnet`. For type backfill, run the [`source-filtering` backfill](../../recipes/source-filtering/). |
| Email never arrives | Send returned 200 but Gmail filtered it | Check Gmail "All Mail" — self-sent automated mail occasionally lands in a non-Inbox label. Add an inbox filter for `subject:"Open Brain Daily Digest"`. |
