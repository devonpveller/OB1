-- count-foreign-held-holders.sql - rw-held-record-residuals (reviewer F3 of rw-held-owner-scope).
-- READ-ONLY: SELECTs only, nothing created or written. Prints COUNTS only - never a path, an id, a title or text.
--   psql -X -A -t -q -f count-foreign-held-holders.sql
-- Held sources are private to their owner until admitted (operator decision 2026-11-23). Before rw-held-owner-scope a
-- user could paste a chip of, or add a reference to, another user's held source into their OWN document, so a
-- reference_holders row of that document may point at a record whose target is someone else's held source. Such a
-- row carries no text the holder did not already write (the id was in the holder's own document), and every reader
-- now answers it as a missing record (FOREIGN_HELD_TARGET); removing the held source now detaches it (removeHeld
-- sets the holder's reference_id to NULL and deletes the record). So no cleanup slot ships with this item: the
-- expected count on a host where only one person has held sources is 0, and a non-zero count is a figure for the
-- operator, not a leak.
-- Lines:
--   foreign_held_holders=<n>        holder rows of a user document whose record targets another user's held source
--                                   (not admitted: no public.sources row with the same id)
--   foreign_held_holder_docs=<n>    the distinct documents those rows sit in
--   foreign_held_records=<n>        the distinct records those rows hold
--   orphan_quoted_records=<n>       records whose target is in neither public.sources nor public.held_sources and has
--                                   no tombstone, still carrying a quote (a held source removed before this fix; such
--                                   a record answers "erased" with its quote to whoever holds its id - F6's residue)
--   orphan_quoted_records_held=<n>  of those, the ones some holder row still holds
WITH fh AS (
    SELECT h.id AS holder_id, h.holder_ref, r.id AS record_id
      FROM public.reference_holders h
      JOIN public.reference_records r ON r.id = h.reference_id
      JOIN public.held_sources hs ON hs.id = r.source_id
      JOIN public.ideas i ON i.id = hs.refinery_id
      JOIN public.user_document_listings l ON l.path = h.holder_ref
     WHERE h.holder_kind = 'user_document'
       AND l.owner_sub <> i.owner_sub
       AND NOT EXISTS (SELECT 1 FROM public.sources s WHERE s.id = r.source_id)
)
SELECT 'foreign_held_holders=' || count(*) FROM fh
UNION ALL SELECT 'foreign_held_holder_docs=' || count(DISTINCT holder_ref) FROM fh
UNION ALL SELECT 'foreign_held_records=' || count(DISTINCT record_id) FROM fh;

WITH orphan AS (
    SELECT r.id
      FROM public.reference_records r
     WHERE NOT EXISTS (SELECT 1 FROM public.sources s WHERE s.id = r.source_id)
       AND NOT EXISTS (SELECT 1 FROM public.held_sources hs WHERE hs.id = r.source_id)
       AND NOT EXISTS (SELECT 1 FROM public.source_tombstones t WHERE t.source_id = r.source_id)
       AND COALESCE(r.selectors #>> '{quote,exact}', '') <> ''
)
SELECT 'orphan_quoted_records=' || count(*) FROM orphan
UNION ALL SELECT 'orphan_quoted_records_held=' || count(*) FROM orphan o
 WHERE EXISTS (SELECT 1 FROM public.reference_holders h WHERE h.reference_id = o.id);
