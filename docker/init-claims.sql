-- ============================================================
-- Claims layer — the grounded-knowledge substrate (Research Engine P1).
--
-- Governing spec: documentation/implementation-guide/research-engine-for-OB/
--   GROUNDING-MODEL.md. This file is the structural enforcement of that
--   rubric. The KB's first-class atom is the GROUNDED CLAIM, not the
--   synthesis blob: a synthesis is the human-readable rendering; claims +
--   their typed grounding edges are the machine-truth.
--
--   claims          — single assertions parsed out of a synthesis; each
--                     MUST carry >=1 grounding edge that terminates in a
--                     primary source, else it is not admitted (a [GAP]).
--   claim_sources   — typed grounding edges (GROUNDING-MODEL §3):
--                       states        — source directly asserts the claim
--                       inferred_from — claim derived/synthesized from source
--                       corroborates  — independent confirmation
--                       contradicts   — source conflicts (surfaced, never hidden)
--                     An edge points at a SOURCE (source_id) or, for
--                     transitive grounding, a PARENT CLAIM (parent_claim_id);
--                     a claim-on-claim chain is valid only if it terminates
--                     in a primary source (enforced by confidence/depth).
--
-- Confidence is a COMPUTED property (§5), recomputed by trigger whenever a
-- claim's edges change — strongest-edge × corroboration × depth-penalty ×
-- authority × freshness, capped by any contradicts edge.
--
-- Conventions mirror init-threads.sql / init-sources.sql:
--   * Idempotent (CREATE ... IF NOT EXISTS, ADD COLUMN IF NOT EXISTS).
--   * *_touch_updated_at trigger for updated_at.
--   * RLS enabled; service_role FOR ALL, authenticated SELECT.
--   * NO DROP TABLE / TRUNCATE / unqualified DELETE (OB1 guardrail).
--   * Embedding VECTOR(1024) (bge-m3) for future claim-level reuse/dedup.
--
-- Ordered to run AFTER init-sources.sql (30) and init-threads.sql (70):
--   sources + threads + link helpers must already exist. Mounted in compose
--   as 94-init-claims.sql. Additive + operator-applied for the live DB (G2/G10).
-- ============================================================

-- ── claims ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.claims (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    text          TEXT NOT NULL,
    -- thread the claim belongs to (the durable line of inquiry). SET NULL,
    -- not CASCADE: archiving/removing a thread must not erase grounded
    -- knowledge — the claim survives, orphaned, re-homeable by the curator.
    thread_id     UUID REFERENCES public.threads(id) ON DELETE SET NULL,
    -- the research_synthesis source row this claim was parsed out of
    -- (provenance back to the verbatim synthesis; §6.6 total provenance).
    synthesis_id  UUID REFERENCES public.sources(id) ON DELETE SET NULL,
    -- raw epistemic tag the synthesis carried for this claim, kept verbatim
    -- ([SOURCED]→sourced, [INFERRED]→inferred, [UNCERTAIN]→uncertain). The
    -- structured truth is the edges; this is provenance of the parse.
    epistemic_tag TEXT NOT NULL DEFAULT 'sourced'
        CHECK (epistemic_tag IN ('sourced','inferred','uncertain')),
    -- lifecycle: a claim is never deleted — conflicting evidence retracts or
    -- supersedes it (§6.5 conflict surfaces, never silent cache preference).
    status        TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active','retracted','superseded')),
    -- computed cache (§5); maintained by recompute_claim_confidence + trigger.
    confidence    REAL NOT NULL DEFAULT 0,
    contradicted  BOOLEAN NOT NULL DEFAULT FALSE,  -- has >=1 contradicts edge
    -- freshness (OD-5 windows: fast 7 / medium 180 / slow 1095). Inherited
    -- from the synthesis/sources at parse time; staleness drops a claim below
    -- the reuse floor until re-validated (§5).
    volatility      TEXT CHECK (volatility IN ('fast','medium','slow')),
    revalidate_days INT,
    researched_on   DATE NOT NULL DEFAULT CURRENT_DATE,
    -- dedup within a thread: md5(normalized text). Lets re-parsing the same
    -- synthesis fold into the existing claim (additive edges) not duplicate it.
    content_hash  TEXT,
    embedding     VECTOR(1024),                    -- bge-m3 (future claim reuse/dedup)
    metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_claims_thread        ON public.claims (thread_id);
CREATE INDEX IF NOT EXISTS idx_claims_synthesis     ON public.claims (synthesis_id);
CREATE INDEX IF NOT EXISTS idx_claims_status        ON public.claims (status);
CREATE INDEX IF NOT EXISTS idx_claims_content_hash  ON public.claims (content_hash);
CREATE INDEX IF NOT EXISTS idx_claims_embedding
    ON public.claims USING hnsw (embedding vector_cosine_ops);
-- One canonical claim per (thread, normalized text) — the dedup key.
CREATE UNIQUE INDEX IF NOT EXISTS uq_claims_thread_hash
    ON public.claims (thread_id, content_hash)
    WHERE content_hash IS NOT NULL;

CREATE OR REPLACE FUNCTION public.claims_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_claims_touch ON public.claims;
CREATE TRIGGER trg_claims_touch
    BEFORE UPDATE ON public.claims
    FOR EACH ROW EXECUTE FUNCTION public.claims_touch_updated_at();

-- ── claim_sources (typed grounding edges) ───────────────────────────────
-- Surrogate id (a single edge has at most one of source_id / parent_claim_id,
-- so a composite PK with a nullable column is awkward). Uniqueness is enforced
-- by two partial indexes below.
CREATE TABLE IF NOT EXISTS public.claim_sources (
    id              BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    claim_id        UUID NOT NULL REFERENCES public.claims(id) ON DELETE CASCADE,
    source_id       UUID REFERENCES public.sources(id) ON DELETE CASCADE,
    parent_claim_id UUID REFERENCES public.claims(id) ON DELETE CASCADE,
    edge_type       TEXT NOT NULL
        CHECK (edge_type IN ('states','inferred_from','corroborates','contradicts')),
    weight          REAL NOT NULL DEFAULT 1.0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- exactly one terminal: a source OR a parent claim (transitive), never both.
    CONSTRAINT claim_sources_one_terminal CHECK (
        (source_id IS NOT NULL AND parent_claim_id IS NULL)
        OR (source_id IS NULL AND parent_claim_id IS NOT NULL)
    ),
    -- a claim cannot ground on itself.
    CONSTRAINT claim_sources_no_self CHECK (parent_claim_id IS NULL OR parent_claim_id <> claim_id)
);
CREATE INDEX IF NOT EXISTS idx_claim_sources_claim  ON public.claim_sources (claim_id);
CREATE INDEX IF NOT EXISTS idx_claim_sources_source ON public.claim_sources (source_id);
CREATE INDEX IF NOT EXISTS idx_claim_sources_parent ON public.claim_sources (parent_claim_id);
-- One logical edge per (claim, terminal, type).
CREATE UNIQUE INDEX IF NOT EXISTS uq_claim_sources_source
    ON public.claim_sources (claim_id, source_id, edge_type) WHERE source_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_claim_sources_parent
    ON public.claim_sources (claim_id, parent_claim_id, edge_type) WHERE parent_claim_id IS NOT NULL;

-- ============================================================
-- §5 — confidence is a computed property of grounding.
-- ============================================================

-- claim_min_depth: shortest grounding distance to a PRIMARY SOURCE following
-- non-contradicts edges. 0 = the claim has a direct source edge. N = grounds
-- (transitively) on a claim that is N hops from a source. NULL = NO path
-- terminates in a source → the claim is UNGROUNDED (a guess; never admitted).
-- Bounded recursion (depth cap 8) guards against pathological chains/cycles.
CREATE OR REPLACE FUNCTION public.claim_min_depth(p_claim_id UUID)
RETURNS INT
LANGUAGE sql STABLE
AS $$
    WITH RECURSIVE walk(claim_id, depth) AS (
        SELECT p_claim_id, 0
        UNION ALL
        SELECT cs.parent_claim_id, w.depth + 1
        FROM walk w
        JOIN public.claim_sources cs ON cs.claim_id = w.claim_id
        WHERE cs.parent_claim_id IS NOT NULL
          AND cs.edge_type <> 'contradicts'
          AND w.depth < 8
    )
    SELECT MIN(w.depth)
    FROM walk w
    WHERE EXISTS (
        SELECT 1 FROM public.claim_sources cs
        WHERE cs.claim_id = w.claim_id
          AND cs.source_id IS NOT NULL
          AND cs.edge_type <> 'contradicts'
    );
$$;

-- claim_is_grounded: rule #1 predicate — does a non-contradicts edge chain
-- terminate in a primary source? (claim_min_depth IS NOT NULL.)
CREATE OR REPLACE FUNCTION public.claim_is_grounded(p_claim_id UUID)
RETURNS BOOLEAN
LANGUAGE sql STABLE
AS $$
    SELECT public.claim_min_depth(p_claim_id) IS NOT NULL;
$$;

-- claim_confidence: §5 scoring. Pure function of the claim's grounding;
-- callers persist it via recompute_claim_confidence.
--   base        — strongest non-contradicts edge: states/corroborates 0.90,
--                 inferred_from 0.60, none 0.0
--   corroboration — each independent confirming source beyond the first adds
--                 0.03, capped +0.10
--   authority   — best grounding source: .gov/.edu/.mil or metadata
--                 authority='primary' → ×1.0, else ×0.85
--   depth       — claim-on-claim distance: ×0.85^depth (educated-guess decay)
--   freshness   — past researched_on + revalidate_days → ×0.5
--   contradicts — any contradicts edge caps the result at 0.30
-- Ungrounded (no terminating source) → 0.0 (rule #1).
CREATE OR REPLACE FUNCTION public.claim_confidence(p_claim_id UUID)
RETURNS REAL
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    v_depth        INT;
    v_base         REAL := 0.0;
    v_corroborators INT := 0;
    v_authority    REAL := 0.85;
    v_has_strong   BOOLEAN := FALSE;
    v_has_inferred BOOLEAN := FALSE;
    v_has_primary  BOOLEAN := FALSE;
    v_contradicted BOOLEAN := FALSE;
    v_stale        BOOLEAN := FALSE;
    v_score        REAL;
BEGIN
    v_depth := public.claim_min_depth(p_claim_id);
    IF v_depth IS NULL THEN
        RETURN 0.0;  -- ungrounded → not knowledge (rule #1)
    END IF;

    -- strongest edge type present (over source + parent-claim edges).
    SELECT
        bool_or(edge_type IN ('states','corroborates')),
        bool_or(edge_type = 'inferred_from'),
        bool_or(edge_type = 'contradicts')
      INTO v_has_strong, v_has_inferred, v_contradicted
    FROM public.claim_sources WHERE claim_id = p_claim_id;

    IF v_has_strong THEN v_base := 0.90;
    ELSIF v_has_inferred THEN v_base := 0.60;
    ELSE v_base := 0.0; END IF;

    -- independent confirming SOURCES (states/corroborates) beyond the first.
    SELECT GREATEST(COUNT(DISTINCT source_id) - 1, 0) INTO v_corroborators
    FROM public.claim_sources
    WHERE claim_id = p_claim_id
      AND source_id IS NOT NULL
      AND edge_type IN ('states','corroborates');

    -- best authority among directly-grounding sources.
    SELECT MAX(CASE
                 WHEN s.domain ~* '\.(gov|edu|mil)(:|/|$)'
                   OR s.url ~* '://[^/]*\.(gov|edu|mil)(:|/|$)'
                   OR (s.metadata ->> 'authority') = 'primary'
                 THEN 1.0 ELSE 0.85 END)
      INTO v_authority
    FROM public.claim_sources cs
    JOIN public.sources s ON s.id = cs.source_id
    WHERE cs.claim_id = p_claim_id
      AND cs.source_id IS NOT NULL
      AND cs.edge_type <> 'contradicts';
    v_authority := COALESCE(v_authority, 0.85);

    -- freshness from the claim's own revalidate window.
    SELECT (researched_on + COALESCE(revalidate_days,
              CASE volatility WHEN 'fast' THEN 7 WHEN 'medium' THEN 180
                              WHEN 'slow' THEN 1095 ELSE 180 END) < CURRENT_DATE)
      INTO v_stale
    FROM public.claims WHERE id = p_claim_id;

    v_score := (v_base + LEAST(0.03 * v_corroborators, 0.10))
               * v_authority
               * power(0.85, v_depth);
    IF COALESCE(v_stale, FALSE) THEN v_score := v_score * 0.5; END IF;
    IF v_contradicted THEN v_score := LEAST(v_score, 0.30); END IF;

    RETURN GREATEST(LEAST(v_score, 1.0), 0.0);
END;
$$;

-- Persist the computed confidence + contradicted flag onto the claim row.
CREATE OR REPLACE FUNCTION public.recompute_claim_confidence(p_claim_id UUID)
RETURNS REAL
LANGUAGE plpgsql
AS $$
DECLARE v_conf REAL; v_contra BOOLEAN;
BEGIN
    v_conf := public.claim_confidence(p_claim_id);
    SELECT bool_or(edge_type = 'contradicts') INTO v_contra
    FROM public.claim_sources WHERE claim_id = p_claim_id;
    UPDATE public.claims
       SET confidence = v_conf,
           contradicted = COALESCE(v_contra, FALSE)
     WHERE id = p_claim_id;
    RETURN v_conf;
END;
$$;

-- Recompute confidence whenever a claim's grounding edges change (§5
-- "recomputed whenever its edges change").
CREATE OR REPLACE FUNCTION public.trg_claim_sources_recompute()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        PERFORM public.recompute_claim_confidence(OLD.claim_id);
        RETURN OLD;
    END IF;
    PERFORM public.recompute_claim_confidence(NEW.claim_id);
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_claim_sources_recompute ON public.claim_sources;
CREATE TRIGGER trg_claim_sources_recompute
    AFTER INSERT OR UPDATE OR DELETE ON public.claim_sources
    FOR EACH ROW EXECUTE FUNCTION public.trg_claim_sources_recompute();

-- ============================================================
-- Write helpers (thin; upsert/flag, never delete) — mirror
-- find_or_create_source / link_source_to_thread so the app layer stays thin
-- and all grounding logic lives server-side.
-- ============================================================

-- Dedup-aware claim insert. Matches on (thread_id, content_hash); content_hash
-- defaults to md5 of the normalized text so dedup works without the caller
-- computing it. Returns the (possibly existing) id + was_duplicate so the
-- caller adds any NEW edges to the canonical claim instead of duplicating it.
CREATE OR REPLACE FUNCTION public.find_or_create_claim(
    p_text          TEXT,
    p_thread_id     UUID          DEFAULT NULL,
    p_synthesis_id  UUID          DEFAULT NULL,
    p_epistemic_tag TEXT          DEFAULT 'sourced',
    p_volatility    TEXT          DEFAULT NULL,
    p_revalidate_days INT         DEFAULT NULL,
    p_embedding     VECTOR(1024)  DEFAULT NULL,
    p_metadata      JSONB         DEFAULT '{}'::jsonb
)
RETURNS TABLE (id UUID, was_duplicate BOOLEAN)
LANGUAGE plpgsql
AS $$
DECLARE
    v_hash TEXT := md5(lower(btrim(COALESCE(p_text, ''))));
    v_tag  TEXT := CASE WHEN p_epistemic_tag IN ('sourced','inferred','uncertain')
                        THEN p_epistemic_tag ELSE 'sourced' END;
    v_id   UUID;
BEGIN
    IF COALESCE(btrim(p_text), '') = '' THEN
        RAISE EXCEPTION 'claim text required';
    END IF;

    -- Match within the same thread (NULL thread = inbox; matches other NULLs).
    SELECT c.id INTO v_id
    FROM public.claims c
    WHERE c.content_hash = v_hash
      AND c.thread_id IS NOT DISTINCT FROM p_thread_id
    ORDER BY c.created_at ASC
    LIMIT 1;

    IF v_id IS NOT NULL THEN
        -- Re-parse refreshes provenance + freshness, never the text.
        UPDATE public.claims
           SET synthesis_id  = COALESCE(p_synthesis_id, synthesis_id),
               researched_on = CURRENT_DATE,
               volatility    = COALESCE(p_volatility, volatility),
               revalidate_days = COALESCE(p_revalidate_days, revalidate_days),
               status        = CASE WHEN status = 'retracted' THEN status ELSE 'active' END
         WHERE public.claims.id = v_id;
        id := v_id; was_duplicate := TRUE;
        RETURN NEXT; RETURN;
    END IF;

    INSERT INTO public.claims
        (text, thread_id, synthesis_id, epistemic_tag, volatility,
         revalidate_days, content_hash, embedding, metadata)
    VALUES
        (btrim(p_text), p_thread_id, p_synthesis_id, v_tag, p_volatility,
         p_revalidate_days, v_hash, p_embedding, COALESCE(p_metadata, '{}'::jsonb))
    RETURNING public.claims.id INTO v_id;

    id := v_id; was_duplicate := FALSE;
    RETURN NEXT;
END;
$$;

-- Upsert a grounding edge claim→source. Idempotent on (claim, source, type).
CREATE OR REPLACE FUNCTION public.link_claim_to_source(
    p_claim_id  UUID,
    p_source_id UUID,
    p_edge_type TEXT DEFAULT 'states',
    p_weight    REAL DEFAULT 1.0
)
RETURNS public.claim_sources
LANGUAGE plpgsql
AS $$
DECLARE v_row public.claim_sources;
BEGIN
    IF p_edge_type NOT IN ('states','inferred_from','corroborates','contradicts') THEN
        RAISE EXCEPTION 'invalid edge_type %', p_edge_type;
    END IF;
    INSERT INTO public.claim_sources (claim_id, source_id, edge_type, weight)
    VALUES (p_claim_id, p_source_id, p_edge_type, p_weight)
    ON CONFLICT (claim_id, source_id, edge_type) WHERE source_id IS NOT NULL
    DO UPDATE SET weight = EXCLUDED.weight
    RETURNING * INTO v_row;
    RETURN v_row;
END;
$$;

-- Upsert a transitive grounding edge claim→parent_claim. The chain is only
-- admitted by confidence/depth if it terminates in a primary source.
CREATE OR REPLACE FUNCTION public.link_claim_to_claim(
    p_claim_id        UUID,
    p_parent_claim_id UUID,
    p_edge_type       TEXT DEFAULT 'inferred_from',
    p_weight          REAL DEFAULT 1.0
)
RETURNS public.claim_sources
LANGUAGE plpgsql
AS $$
DECLARE v_row public.claim_sources;
BEGIN
    IF p_edge_type NOT IN ('states','inferred_from','corroborates','contradicts') THEN
        RAISE EXCEPTION 'invalid edge_type %', p_edge_type;
    END IF;
    IF p_claim_id = p_parent_claim_id THEN
        RAISE EXCEPTION 'a claim cannot ground on itself';
    END IF;
    INSERT INTO public.claim_sources (claim_id, parent_claim_id, edge_type, weight)
    VALUES (p_claim_id, p_parent_claim_id, p_edge_type, p_weight)
    ON CONFLICT (claim_id, parent_claim_id, edge_type) WHERE parent_claim_id IS NOT NULL
    DO UPDATE SET weight = EXCLUDED.weight
    RETURNING * INTO v_row;
    RETURN v_row;
END;
$$;

-- Conflict handling (§6.5): record an external contradiction against a claim
-- and flag it for review. The contradicting material is itself a source; this
-- never silently prefers the cached claim.
CREATE OR REPLACE FUNCTION public.retract_claim(
    p_claim_id UUID,
    p_reason   TEXT DEFAULT NULL
)
RETURNS public.claims
LANGUAGE plpgsql
AS $$
DECLARE v_row public.claims;
BEGIN
    UPDATE public.claims
       SET status = 'retracted',
           metadata = COALESCE(metadata,'{}'::jsonb)
                      || jsonb_build_object('retraction_reason', p_reason)
     WHERE id = p_claim_id
    RETURNING * INTO v_row;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'no claim %', p_claim_id;
    END IF;
    RETURN v_row;
END;
$$;

-- ============================================================
-- §6.1/§6.2 — enforcement & reuse audit surfaces.
-- ============================================================

-- ungrounded_claims: the rule #1 backstop. Any active claim whose grounding
-- does NOT terminate in a primary source. The app-layer parser must never
-- create these (it records them as [GAP]s); this view catches drift if a path
-- bypasses the gate. Should be empty in a healthy KB.
CREATE OR REPLACE VIEW public.ungrounded_claims AS
    SELECT c.id, c.text, c.thread_id, c.synthesis_id, c.created_at
    FROM public.claims c
    WHERE c.status = 'active'
      AND public.claim_min_depth(c.id) IS NULL;

-- reusable_claims: §6.2 — a claim may be served from cache / reused only if it
-- is grounded AND fresh AND above the confidence floor (0.50). This is the
-- single read-path the cache/reuse layer (P2.3) consults.
CREATE OR REPLACE VIEW public.reusable_claims AS
    SELECT c.*
    FROM public.claims c
    WHERE c.status = 'active'
      AND c.confidence >= 0.50
      AND public.claim_min_depth(c.id) IS NOT NULL
      AND (c.researched_on + COALESCE(c.revalidate_days,
             CASE c.volatility WHEN 'fast' THEN 7 WHEN 'medium' THEN 180
                               WHEN 'slow' THEN 1095 ELSE 180 END)) >= CURRENT_DATE;

-- ── RLS + policies (mirror init-threads.sql) ────────────────────────────
ALTER TABLE public.claims        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.claim_sources ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS claims_service_role_all        ON public.claims;
DROP POLICY IF EXISTS claim_sources_service_role_all ON public.claim_sources;
CREATE POLICY claims_service_role_all        ON public.claims
    FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY claim_sources_service_role_all ON public.claim_sources
    FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS claims_authenticated_select        ON public.claims;
DROP POLICY IF EXISTS claim_sources_authenticated_select ON public.claim_sources;
CREATE POLICY claims_authenticated_select        ON public.claims
    FOR SELECT TO authenticated USING (true);
CREATE POLICY claim_sources_authenticated_select ON public.claim_sources
    FOR SELECT TO authenticated USING (true);

-- ── Grants (additive; init-grants.sql covers future objects, these make the
--    file self-sufficient if run standalone) ───────────────────────────────
GRANT ALL    ON public.claims        TO service_role;
GRANT ALL    ON public.claim_sources TO service_role;
GRANT SELECT ON public.claims        TO authenticated;
GRANT SELECT ON public.claim_sources TO authenticated;
GRANT SELECT ON public.ungrounded_claims, public.reusable_claims TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_min_depth(UUID)            TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_is_grounded(UUID)          TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_confidence(UUID)           TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION public.recompute_claim_confidence(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.find_or_create_claim(
    TEXT, UUID, UUID, TEXT, TEXT, INT, VECTOR, JSONB)             TO service_role;
GRANT EXECUTE ON FUNCTION public.link_claim_to_source(UUID, UUID, TEXT, REAL) TO service_role;
GRANT EXECUTE ON FUNCTION public.link_claim_to_claim(UUID, UUID, TEXT, REAL)  TO service_role;
GRANT EXECUTE ON FUNCTION public.retract_claim(UUID, TEXT)        TO service_role;

-- PostgREST schema-cache reload (no-op if PostgREST not yet up).
NOTIFY pgrst, 'reload schema';
