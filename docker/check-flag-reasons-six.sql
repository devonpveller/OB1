-- check-flag-reasons-six.sql - rwr-flag-reasons-six (slot 680): is the flag_reasons registry the six the dialog offers?
-- Read-only; prints counts only, never a flag's note or owner.
--   psql -X -A -t -q -f check-flag-reasons-six.sql
-- Lines: "check: <what>=<count>" per rule, then "check: OK" or "check: FAIL <rules>".
-- Rules: the six keys are registered and active; no other active key; no flag holds a reason the registry does not
-- list as active (a flag's reason is always one the dialog can name).
WITH r AS (
  SELECT 'reasons_missing' AS what, (
      SELECT count(*) FROM (VALUES ('wrong_claim'), ('low_quality'), ('duplicate'), ('outdated'), ('broken_link'), ('other')) v(k)
       WHERE NOT EXISTS (SELECT 1 FROM public.contract_registry_entries e
                          WHERE e.registry = 'flag_reasons' AND e.key = v.k AND e.retired_at IS NULL)) AS n
  UNION ALL
  SELECT 'reasons_extra', (
      SELECT count(*) FROM public.contract_registry_entries e
       WHERE e.registry = 'flag_reasons' AND e.retired_at IS NULL
         AND e.key NOT IN ('wrong_claim', 'low_quality', 'duplicate', 'outdated', 'broken_link', 'other'))
  UNION ALL
  SELECT 'flags_with_unlisted_reason', (
      SELECT count(*) FROM public.user_flags f
       WHERE NOT EXISTS (SELECT 1 FROM public.contract_registry_entries e
                          WHERE e.registry = 'flag_reasons' AND e.key = f.reason AND e.retired_at IS NULL))
)
SELECT 'check: ' || what || '=' || n FROM r
UNION ALL
SELECT CASE WHEN (SELECT sum(n) FROM r) = 0 THEN 'check: OK'
            ELSE 'check: FAIL ' || (SELECT string_agg(what, ',') FROM r WHERE n <> 0) END;
