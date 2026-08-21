#!/usr/bin/env python3
"""
migrate-ideas-backfill.py — Idea Refinery IR.7 migration (one-off, operator-run).

Seeds the Idea Refinery backlog from EXISTING Open Brain idea-typed thoughts:
each qualifying thought becomes a first-class `ideas` row (+ revision 1 linked
back to the thought, reusing its embedding). It does NOT research anything — the
nightly drain (openbrain-idea-refinery) does, gently. Idempotent: a thought
already migrated (its id present in idea_revisions.thought_id) is skipped, so it
is safe to re-run and to run with --limit for a staged rollout.

Backfill posture (IR.7 open decision — the DEFAULT is the safe one):
  default      backfilled ideas land 'dormant' and PARKED — the drain will NOT
               auto-research them; they surface via find_idea ("show my parked
               ideas") and are researched only when the user asks (research_idea).
  --research   backfilled ideas land 'dormant' but OWED — the drain slow-trickle
               researches them (low-priority tail behind fresh ideas).

Run AFTER the rollout gate (fake-driven E2E + a staging run) and after the drain
is enabled. Never a flood either way: the drain bounds research per cycle.

Env (or --dsn): DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD.
Requires: psycopg2 (pip install psycopg2-binary).
"""
import argparse
import os
import sys

try:
    import psycopg2
except ImportError:
    sys.exit("psycopg2 is required: pip install psycopg2-binary")

PARKED_SENTINEL = "backfill-parked"  # a non-NULL research_job_id keeps it OUT of the owed queue


def connect(dsn):
    if dsn:
        return psycopg2.connect(dsn)
    return psycopg2.connect(
        host=os.environ.get("DB_HOST", "openbrain-db"),
        port=int(os.environ.get("DB_PORT", "5432")),
        dbname=os.environ.get("DB_NAME", "openbrain"),
        user=os.environ.get("DB_USER", "postgres"),
        password=os.environ.get("DB_PASSWORD", ""),
    )


def main():
    ap = argparse.ArgumentParser(description="Backfill Idea Refinery ideas from existing OB thoughts.")
    ap.add_argument("--dsn", default=os.environ.get("DATABASE_URL", ""), help="Postgres DSN (else DB_* env).")
    ap.add_argument("--type", default="idea", help="thoughts.metadata->>'type' to migrate (default: idea).")
    ap.add_argument("--limit", type=int, default=0, help="max thoughts to migrate this run (0 = all).")
    ap.add_argument("--research", action="store_true",
                    help="mark backfilled ideas OWED (drain slow-trickles). Default: parked/on-request.")
    ap.add_argument("--dry-run", action="store_true", help="report what would migrate; write nothing.")
    args = ap.parse_args()

    job = None if args.research else PARKED_SENTINEL
    conn = connect(args.dsn)
    conn.autocommit = False
    migrated = 0
    try:
        with conn.cursor() as cur:
            limit_sql = "LIMIT %s" if args.limit > 0 else ""
            params = [args.type] + ([args.limit] if args.limit > 0 else [])
            cur.execute(
                f"""SELECT id, content, embedding::text, created_at
                      FROM thoughts t
                     WHERE t.metadata->>'type' = %s
                       AND NOT EXISTS (SELECT 1 FROM idea_revisions r WHERE r.thought_id = t.id)
                     ORDER BY t.created_at ASC
                     {limit_sql}""",
                params,
            )
            rows = cur.fetchall()
            print(f"candidates: {len(rows)} (type='{args.type}', mode={'owed' if args.research else 'parked'})")
            for tid, content, emb, created_at in rows:
                content = content or ""
                title = content.splitlines()[0][:120].strip() if content.strip() else f"idea {tid}"
                summary = content
                cur.execute(
                    """INSERT INTO ideas
                         (title, summary, domain, embedding, status, current_revision, metadata, created_at)
                       VALUES (%s, %s, 'ai-stack', %s::vector, 'dormant', 1, '{"backfill": true}'::jsonb, %s)
                       RETURNING id""",
                    (title, summary, emb, created_at),
                )
                idea_id = cur.fetchone()[0]
                cur.execute(
                    """INSERT INTO idea_revisions
                         (idea_id, revision, summary, thought_id, research_job_id, content_hash)
                       VALUES (%s, 1, %s, %s, %s, md5(lower(btrim(%s))))""",
                    (idea_id, summary, tid, job, summary),
                )
                migrated += 1
        if args.dry_run:
            conn.rollback()
            print(f"DRY RUN — would migrate {migrated} idea(s); rolled back.")
        else:
            conn.commit()
            print(f"migrated {migrated} idea(s) as dormant/{'owed' if args.research else 'parked'}.")
    except Exception as e:  # noqa: BLE001
        conn.rollback()
        sys.exit(f"migration failed (rolled back): {e}")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
