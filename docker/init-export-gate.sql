-- ============================================================
-- Research workbench P6b - the export verification gate (rw-p6b-gate). Slot 310.
--
-- Governing plan (private plan store): implementation-guide/research-workbench/
--   03-PLAN.md P6b, 01-OPEN-ITEMS.md D9 (licence policy) / D15 (the roll-up), 07-MULTI-USER.md.
--
-- A PDF export is checked BEFORE it leaves the workbench (src/export/gate.ts): pdftoppm rasterises
-- it (a separate process), pikepdf + pdfplumber check its structure and layout (a separate Python
-- process), the reference list is matched one-to-one with the document's references, a report's
-- credibility roll-up section must be present, and - when configured - a vision model reached
-- through LiteLLM looks at the pages. A blocked export is never served. What this file adds:
--   1. export_runs                 every gated export: whose (owner_sub, the identity seam's subject),
--                                  what (path, format, style), the verdict (passed | blocked), the
--                                  blocking findings and warnings, which checks ran, and - for a
--                                  passed export only - the file, so the export panel can serve it
--                                  again. Per user: read and written only for the caller's subject.
--   2. registry export_required_sections  sections an exported file must carry, by what the page is
--                                  (D18: declared rows, never a closed list in code). One row: the
--                                  report credibility roll-up (P3b writes it; P6b's gate requires it).
--   3. export_formats.pdf gains definition.gate = true (the formats the gate checks; a row flag).
-- The grounding chain (sources -> claims -> reports) is untouched. Idempotent and additive; RLS on
-- with the service_role FOR ALL policy (the P0 shape). Fresh-volume slot 310 (after rw-idea-schedule's
-- 300); the live DB gets it by hand (psql -f) BEFORE the new workbench image. Revert:
-- revert-export-gate.sql.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.export_runs (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_sub          TEXT NOT NULL CHECK (length(btrim(owner_sub)) > 0),
    actor_sub          TEXT NOT NULL DEFAULT '',
    path               TEXT NOT NULL,
    format             TEXT NOT NULL,
    style              TEXT NOT NULL,
    status             TEXT NOT NULL CHECK (status IN ('passed', 'blocked')),
    blocking_findings  JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(blocking_findings) = 'array'),
    warnings           JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(warnings) = 'array'),
    checks             JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(checks) = 'object'),
    filename           TEXT NOT NULL DEFAULT '',
    mime               TEXT NOT NULL DEFAULT '',
    sha256             TEXT,
    bytes              INT,
    file               BYTEA,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- a blocked export never carries its file (it never leaves); a passed one always does
    CHECK ((status = 'passed') = (file IS NOT NULL)),
    CHECK (status = 'passed' OR jsonb_array_length(blocking_findings) > 0)
);
CREATE INDEX IF NOT EXISTS idx_export_runs_owner ON public.export_runs (owner_sub, created_at DESC);

ALTER TABLE public.export_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS export_runs_service_role_all ON public.export_runs;
CREATE POLICY export_runs_service_role_all ON public.export_runs
    FOR ALL TO service_role USING (true) WITH CHECK (true);
GRANT ALL ON public.export_runs TO service_role;

-- ── the required sections ────────────────────────────────────────────────
INSERT INTO public.contract_registries (name, owner, description) VALUES
    ('export_required_sections', 'P6b', 'sections an exported file must carry; definition.when (frontmatter match) / heading / must_include / formats')
ON CONFLICT (name) DO NOTHING;

-- The report credibility roll-up (D15; 03-PLAN P3b acceptance 4, P6b cross-reference): an export of a
-- research report (frontmatter content_type: research_synthesis - the wiki viewer's research-report
-- page class) must show the roll-up with the claim-kind weights it used. The gate finds `heading` as a
-- line of the file's text and each `must_include` text after it (case-insensitive); missing = blocked.
-- P3b owns the section's wording: a different heading is a change of this row, not of the gate.
INSERT INTO public.contract_registry_entries (registry, key, label, definition) VALUES
    ('export_required_sections', 'credibility-rollup', 'Report credibility roll-up (D15, P3b)',
        '{"when":{"frontmatter":{"content_type":["research_synthesis"]}},"heading":"Report credibility","must_include":["weights"],"formats":["pdf"],"owner":"P3b"}')
ON CONFLICT (registry, key) DO UPDATE SET label = EXCLUDED.label, definition = EXCLUDED.definition;

-- ── the gated formats ────────────────────────────────────────────────────
UPDATE public.contract_registry_entries
   SET definition = definition || '{"gate":true}'::jsonb
 WHERE registry = 'export_formats' AND key = 'pdf' AND NOT (definition ? 'gate');

NOTIFY pgrst, 'reload schema';
