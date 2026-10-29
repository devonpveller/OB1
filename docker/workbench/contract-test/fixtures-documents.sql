-- fixtures-documents.sql - re-lists the two fixture documents of fixtures.sql on a database whose workbench
-- has ALREADY STARTED (rw-p2b-workspace round 4). The workbench reconciles the default identity's listing
-- with its documents tree at start-up and removes a listing whose file is missing (D12: the listing is
-- rebuildable from the files), so on a fresh disposable workbench the fixture rows were gone before Dredd
-- ran: GET /contract/ideas/{id} answered members.document null, and the documented POST /contract/references
-- example (holder documents/fixture-refinery.md) was refused 404 by the ownership gate. The runners write the
-- two files into the disposable vault (fixture-vault.ts MANIFEST) and apply this file after the workbench is up.
-- The rows are owned by the seam's default identity ('operator', the column default) - the identity Dredd runs as.
-- Idempotent: the same rows as fixtures.sql, ON CONFLICT DO NOTHING.
INSERT INTO public.user_document_listings (id, path, title, refinery_id, outbound_links) VALUES
  ('e0000000-0000-4000-8000-0000000000e1', 'documents/fixture-refinery.md', 'Fixture refinery document',
   'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',
   '[{"kind": "source", "id": "11111111-1111-4111-8111-111111111111", "pin": 2},
     {"kind": "source", "id": "cccccccc-cccc-4ccc-8ccc-ccccccccccc1", "pin": null},
     {"kind": "page", "id": "content/tool/tool-fixture", "pin": null}]'),
  ('e0000000-0000-4000-8000-0000000000e2', 'documents/links-suppressed.md', 'Document linking a suppressed source', NULL,
   '[{"kind": "source", "id": "d0000000-0000-4000-8000-0000000000d2", "pin": null}]')
ON CONFLICT (id) DO NOTHING;
