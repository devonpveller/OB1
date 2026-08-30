-- init-agent-memory-corpus-plane.sql
--
-- The exposure plane, applied INSIDE the database, to the one corpus reader that is not a
-- line of TypeScript.
--
-- WHY. dark-factory-unification U5 extends the personal-plane boundary to every reader of
-- `thoughts`. The six statements in openbrain-mcp's index.ts and the one in
-- extensions-server go through their servers' door plane. `match_thoughts` does not: it is a
-- SQL function that RETURNS content, and every caller of it - integrations/agent-memory-api,
-- integrations/open-brain-rest, server/index.ts, the OB1 recipes, and `openbrain-postgrest`
-- through `rpc/match_thoughts` - reads the corpus without passing through any of that code.
--
-- A boundary that stops at the application layer is a boundary with a documented way round
-- it. This is the floor underneath it.
--
-- WHAT IT DOES. Adds ONE predicate to the existing WHERE:
--
--     t.metadata->>'exposure' IS NULL  OR  t.metadata->>'exposure' = ANY(ARRAY['ops'])
--
-- Character-identical in meaning to `corpusPlanePredicate` in
-- integrations/kubernetes-deployment/agent-memory-plane.ts, which is where the reasoning
-- lives: an ABSENT label means the row is unclaimed general corpus (12,989 of 12,993
-- production rows, measured 2026-08-30) and stays visible; a PRESENT label means the
-- agent-memory mirror claimed the row for a plane, and only the ops plane's rows are served.
--
-- NO PARAMETER, DELIBERATELY. The obvious shape is `allowed_exposures TEXT[] DEFAULT
-- ARRAY['ops']`, and it is wrong: it hands the caller a widening argument, and "the caller
-- may name the plane it reads" is precisely the property every layer above this one refuses
-- to have. A function is not a door. If a personal-plane reader is ever needed it gets its
-- own function and its own door, argued for on the record.
--
-- MEASURED BLAST RADIUS: zero rows change hands. Production `thoughts` holds 12,989
-- unlabelled rows and 4 labelled `ops`; both classes satisfy the new predicate, so every
-- existing caller sees exactly what it saw before. Verified before writing this file:
--   SELECT COALESCE(metadata->>'exposure','(none)'), count(*) FROM thoughts GROUP BY 1;
--     (none) | 12989
--     ops    |     4
--
-- NOT A GRANT CHANGE. `openbrain-postgrest` projecting `agent_memories` unauthenticated over
-- open-brain_obnet is a separate, recorded finding and the OPERATOR'S call, because
-- narrowing those grants touches live consumers. This file changes a function BODY. It
-- narrows what `rpc/match_thoughts` returns for labelled rows, which today is nothing, and
-- it touches no role, no grant and no schema exposure setting.
--
-- THE `filter` PARAMETER IS STILL IGNORED, and that is left exactly as found. The original
-- body accepts a JSONB `filter` argument and never references it, so a caller that passes a
-- metadata predicate gets an unfiltered answer and no error - which matters because the
-- cloud gateway's containment mechanic IS a forced metadata_filter. No deployed caller in
-- this stack passes a non-empty one (agent-memory-api passes {}), so honouring it here would
-- be a behaviour change outside U5's boundary work; it is recorded as a finding instead.
--
-- ADDITIVE AND REVERSIBLE: CREATE OR REPLACE with the same signature and the same return
-- type. Revert by re-running the definition in init.sql (lines 27-50), which is unchanged.
--
-- TWO PLACES, ALWAYS: mounted in the initdb chain for fresh volumes, and applied to the live
-- volume per documentation/implementation-guide/agent-memory-plane/PROMOTION-RUNBOOK.md.

CREATE OR REPLACE FUNCTION match_thoughts(
    query_embedding vector(1024),
    match_threshold FLOAT DEFAULT 0.5,
    match_count INT DEFAULT 10,
    filter JSONB DEFAULT '{}'::jsonb
)
RETURNS TABLE (
    id BIGINT,
    content TEXT,
    metadata JSONB,
    similarity FLOAT,
    created_at TIMESTAMP WITH TIME ZONE
)
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    SELECT
        t.id,
        t.content,
        t.metadata,
        (1 - (t.embedding <=> query_embedding))::FLOAT AS similarity,
        t.created_at
    FROM thoughts t
    WHERE 1 - (t.embedding <=> query_embedding) >= match_threshold
      -- THE EXPOSURE PLANE. Parenthesised as a whole: it contains an OR, and an
      -- unparenthesised OR next to an AND is the precedence defeat a verifier executed
      -- against this subsystem's TypeScript query builder - `x AND a OR b` reads as
      -- `(x AND a) OR b`, and the second branch has no plane in it.
      AND (t.metadata->>'exposure' IS NULL
           OR t.metadata->>'exposure' = ANY(ARRAY['ops']))
    ORDER BY t.embedding <=> query_embedding
    LIMIT match_count;
END;
$$;

-- ---------------------------------------------------------------------------------------
-- upsert_thought - the OTHER corpus function, and it is a reader too
-- ---------------------------------------------------------------------------------------
--
-- It is named as a writer, and its dedup lookup is `SELECT * INTO v_row FROM public.thoughts
-- WHERE content_fingerprint = v_fp`, with `RETURNS public.thoughts`. So a caller that knows
-- (or guesses) a thought's exact content gets the whole row back - content, metadata and
-- all - and, worse, the UPDATE branch MERGES ITS OWN METADATA INTO IT. An ops-plane writer
-- could therefore have merged into a personal-plane row and read it back in one call.
--
-- Found while deriving the corpus-function list for the U5 completeness gate, not by a
-- verifier: nothing in the TypeScript layer names `thoughts` here, so no file-level scan
-- would ever have seen it.
--
-- THE FIX IS ONE PREDICATE ON THE DEDUP LOOKUP. An off-plane row is simply not found, so
-- the ELSE branch inserts a new row instead of merging into one the caller may not read.
-- That is safe because `idx_thoughts_content_fingerprint` is NON-UNIQUE BY DESIGN
-- (init-graph.sql says so in its own header), so two rows with one fingerprint violate
-- nothing. Everything else in the function is byte-identical to init-graph.sql:88-113.
--
-- MEASURED BLAST RADIUS: zero. Every production row is unlabelled or `ops`, and both
-- satisfy the predicate, so dedup finds exactly what it found before.

CREATE OR REPLACE FUNCTION public.upsert_thought(
  p_content TEXT,
  p_payload JSONB DEFAULT '{}'::jsonb
)
RETURNS public.thoughts
LANGUAGE plpgsql
AS $$
DECLARE
  v_fp   TEXT := encode(digest(p_content, 'sha256'), 'hex');
  v_meta JSONB := COALESCE(p_payload->'metadata', '{}'::jsonb);
  v_row  public.thoughts;
BEGIN
  SELECT * INTO v_row FROM public.thoughts
    WHERE content_fingerprint = v_fp
      -- THE EXPOSURE PLANE, parenthesised as a whole (it contains an OR).
      AND (metadata->>'exposure' IS NULL
           OR metadata->>'exposure' = ANY(ARRAY['ops']))
    LIMIT 1;
  IF FOUND THEN
    UPDATE public.thoughts
       SET metadata = metadata || v_meta, updated_at = now()
     WHERE id = v_row.id
     RETURNING * INTO v_row;
  ELSE
    INSERT INTO public.thoughts (content, metadata)
      VALUES (p_content, v_meta)
      RETURNING * INTO v_row;
  END IF;
  RETURN v_row;
END;
$$;
