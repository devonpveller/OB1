-- Contract fixtures (rw-p0-contract). Applied ONLY to the disposable database the contract
-- test run creates (run-contract-tests.ps1), after the real initdb chain. Never against a live
-- database: every id is a fixed fixture uuid from src/contracts/schemas/fixtures.ts, and the
-- OpenAPI examples name them, so Dredd exercises each example against these rows.
\set ON_ERROR_STOP on
BEGIN;

INSERT INTO public.threads (id, name, slug) VALUES
  ('0a000000-0000-4000-8000-0000000000a1', 'Fixture notebook', 'fixture-notebook');

-- Sources --------------------------------------------------------------------------------
INSERT INTO public.sources (id, url, title, content, content_type, domain, metadata) VALUES
  ('11111111-1111-4111-8111-111111111111', 'https://example.org/active', 'Active fixture source',
   'Alpha fixture text about contract retrieval. Beta sentence two. Gamma sentence three.', 'web_article', 'example.org', '{}'),
  ('22222222-2222-4222-8222-222222222222', 'https://example.org/suppressed', 'Suppressed fixture source',
   'A misattributed quote about contract retrieval.', 'web_article', 'example.org', '{}'),
  ('33333333-3333-4333-8333-333333333333', 'https://example.org/unlinked', 'Unlinked fixture source',
   'Nothing depends on this text any more.', 'web_article', 'example.org', '{}'),
  ('44444444-4444-4444-8444-444444444444', 'https://example.org/to-sever', 'Source with one chunk to sever',
   'One chunk of text.', 'web_article', 'example.org', '{}'),
  ('d0000000-0000-4000-8000-0000000000d1', 'https://example.org/to-suppress', 'Source the Dredd run suppresses',
   'Suppress me.', 'web_article', 'example.org', '{}'),
  ('d0000000-0000-4000-8000-0000000000d2', 'https://example.org/doc-linked', 'Suppressed source a user document links',
   'Linked from a user document.', 'web_article', 'example.org', '{}'),
  ('d0000000-0000-4000-8000-0000000000d3', 'https://example.org/lead-target', 'Credible source reached through a lead',
   'Reached via the suppressed source.', 'paper', 'example.org',
   '{"found_via": "22222222-2222-4222-8222-222222222222", "doi": "10.0000/fixture"}'),
  ('77777777-7777-4777-8777-777777777777', NULL, 'Fixture research synthesis',
   'Synthesis citing [Source 1] and [Source 2].', 'research_synthesis', NULL,
   '{"source_ids": ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"]}');

-- revisions: the active source is at revision 2
INSERT INTO public.source_revisions (source_id, revision, content, title, edited_by) VALUES
  ('11111111-1111-4111-8111-111111111111', 1, 'Alpha original text.', 'Active fixture source', 'original'),
  ('11111111-1111-4111-8111-111111111111', 2, 'Alpha fixture text about contract retrieval. Beta sentence two. Gamma sentence three.', 'Active fixture source', 'operator');

INSERT INTO public.source_chunks (source_id, idx, content) VALUES
  ('11111111-1111-4111-8111-111111111111', 0, 'Alpha fixture text about contract retrieval.'),
  ('11111111-1111-4111-8111-111111111111', 1, 'Beta sentence two.'),
  ('11111111-1111-4111-8111-111111111111', 2, 'Gamma sentence three.'),
  ('22222222-2222-4222-8222-222222222222', 0, 'A misattributed quote about contract retrieval.'),
  ('44444444-4444-4444-8444-444444444444', 0, 'One chunk of text.');

INSERT INTO public.thread_sources (thread_id, source_id, link_type, status) VALUES
  ('0a000000-0000-4000-8000-0000000000a1', '11111111-1111-4111-8111-111111111111', 'deliberate', 'confirmed'),
  ('0a000000-0000-4000-8000-0000000000a1', '22222222-2222-4222-8222-222222222222', 'deliberate', 'confirmed');

-- Claims: one claim grounded by the active source (states) and the suppressed one (corroborates)
INSERT INTO public.claims (id, text, thread_id, synthesis_id, epistemic_tag) VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', 'Fixture claim: contracts own record states.',
   '0a000000-0000-4000-8000-0000000000a1', '77777777-7777-4777-8777-777777777777', 'sourced');
INSERT INTO public.claim_sources (claim_id, source_id, edge_type) VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', '11111111-1111-4111-8111-111111111111', 'states'),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', '22222222-2222-4222-8222-222222222222', 'corroborates');

-- An entity page that cites both leaves; the two source leaves themselves
INSERT INTO public.entities (id, entity_type, canonical_name, normalized_name) VALUES
  (900001, 'tool', 'Tool Fixture', 'tool fixture');
INSERT INTO public.source_entities (source_id, entity_id, mention_role) VALUES
  ('22222222-2222-4222-8222-222222222222', 900001, 'mentioned');
INSERT INTO public.wiki_pages (slug, page_class, entity_type, title, body, links) VALUES
  ('content/tool/tool-fixture', 'entity', 'tool', 'Tool Fixture', 'An entity page about contract retrieval fixtures.',
   '["content/source/11111111-1111-4111-8111-111111111111", "content/source/22222222-2222-4222-8222-222222222222"]'),
  ('content/source/11111111-1111-4111-8111-111111111111', 'source', NULL, 'Active fixture source', 'Leaf.', '[]'),
  ('content/source/22222222-2222-4222-8222-222222222222', 'source', NULL, 'Suppressed fixture source', 'Leaf.', '[]');

-- A research session (staging pool) and its job; the idea that triggered it
INSERT INTO public.ideas (id, title, summary, status, current_revision, thread_root) VALUES
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1', 'Fixture idea', 'An idea about the retrieval contract.', 'researched', 1, 'mm-root-fixture');
INSERT INTO public.sessions (id, origin_tool, query_text, thread_id) VALUES
  ('88888888-8888-4888-8888-888888888888', 'owui', 'fixture question', '0a000000-0000-4000-8000-0000000000a1');
INSERT INTO public.session_sources (session_id, source_id) VALUES
  ('88888888-8888-4888-8888-888888888888', '11111111-1111-4111-8111-111111111111'),
  ('88888888-8888-4888-8888-888888888888', '22222222-2222-4222-8222-222222222222'),
  ('88888888-8888-4888-8888-888888888888', '77777777-7777-4777-8777-777777777777');
INSERT INTO public.research_jobs (id, status, origin, query, thread_id, session_id, progress, result, inlet_ref, caller,
                                  started_at, finished_at) VALUES
  ('99999999-9999-4999-8999-999999999999', 'done', 'owui', 'fixture question', '0a000000-0000-4000-8000-0000000000a1',
   '88888888-8888-4888-8888-888888888888', '{"phase": "done", "message": "finished"}',
   '{"claims": [{"text": "Fixture claim"}], "cited_sources": ["11111111-1111-4111-8111-111111111111"], "gaps": ["what about erasure?"]}',
   '{"kind": "chat_id", "id": "owui-chat-fixture"}', 'owui-tool', now(), now());
-- A revision carries the thought it was captured as; the memory-plane RLS (200-init-graph-
-- plane-rls.sql) shows service_role only revisions whose thought it can see, as in production.
INSERT INTO public.thoughts (id, content, exposure, metadata) VALUES
  (900001, 'An idea about the retrieval contract.', 'ops', '{"type": "idea"}');
INSERT INTO public.idea_revisions (idea_id, revision, summary, research_job_id, thought_id) VALUES
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1', 1, 'An idea about the retrieval contract.', '99999999-9999-4999-8999-999999999999', 900001);
UPDATE public.ideas SET dossier_source_id = '77777777-7777-4777-8777-777777777777', last_job_id = '99999999-9999-4999-8999-999999999999'
 WHERE id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';

INSERT INTO public.import_jobs (id, status, source_id) VALUES
  ('99999999-9999-4999-8999-99999999999a', 'done', '11111111-1111-4111-8111-111111111111');

-- Held user sources in the idea's refinery; its one user document links the active source
-- (pinned at revision 2), the linked held source and a page.
INSERT INTO public.held_sources (id, refinery_id, url, title, content, content_type, metadata) VALUES
  ('cccccccc-cccc-4ccc-8ccc-ccccccccccc1', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1', 'https://example.org/held-linked',
   'Held fixture source (linked)', 'Held text about contract retrieval in the refinery.', 'web_article', '{"user_provided": true}'),
  ('cccccccc-cccc-4ccc-8ccc-ccccccccccc2', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1', NULL,
   'Held fixture source (removable)', 'Nobody links this held text.', 'manual', '{"user_provided": true}');
INSERT INTO public.held_source_chunks (held_source_id, idx, content) VALUES
  ('cccccccc-cccc-4ccc-8ccc-ccccccccccc1', 0, 'Held text about contract retrieval in the refinery.');
INSERT INTO public.refinery_user_sources (refinery_id, source_id, status) VALUES
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1', 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1', 'held'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1', 'cccccccc-cccc-4ccc-8ccc-ccccccccccc2', 'held');
INSERT INTO public.user_document_listings (id, path, title, refinery_id, outbound_links) VALUES
  ('e0000000-0000-4000-8000-0000000000e1', 'documents/fixture-refinery.md', 'Fixture refinery document',
   'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',
   '[{"kind": "source", "id": "11111111-1111-4111-8111-111111111111", "pin": 2},
     {"kind": "source", "id": "cccccccc-cccc-4ccc-8ccc-ccccccccccc1", "pin": null},
     {"kind": "page", "id": "content/tool/tool-fixture", "pin": null}]'),
  ('e0000000-0000-4000-8000-0000000000e2', 'documents/links-suppressed.md', 'Document linking a suppressed source', NULL,
   '[{"kind": "source", "id": "d0000000-0000-4000-8000-0000000000d2", "pin": null}]');
INSERT INTO public.refinery_members (refinery_id, member_kind, member_ref) VALUES
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1', 'podcast', 'podcast-fixture-1');

-- Lifecycle states: suppressed (with dependence), unlinked (none), the sever target, the
-- document-linked one. The sever target and the doc-linked one are suppressed too.
UPDATE public.sources
   SET retracted_at = now(), retraction_committed_at = now(), retracted_by = 'fixture',
       suppression_reason = 'misattributed quote',
       suppression_context = '{"title": "Suppressed fixture source", "url": "https://example.org/suppressed", "score_at_removal": {"value": 0.6, "version": "claim-confidence-mean-v1"}}'
 WHERE id IN ('22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333',
              '44444444-4444-4444-8444-444444444444', 'd0000000-0000-4000-8000-0000000000d2');
UPDATE public.sources SET unlinked_at = now() WHERE id = '33333333-3333-4333-8333-333333333333';
SELECT public.recompute_claims_for_source('22222222-2222-4222-8222-222222222222');

-- Tombstones: one automation-erased (debunked), one user-erased (deliberate) the run lifts.
INSERT INTO public.source_tombstones (id, source_id, url, url_key, title, reason_type, note, batch_run_id,
                                      eraser_kind, eraser_run_id, confidence, score_version, fingerprint) VALUES
  ('66666666-6666-4666-8666-666666666666', '55555555-5555-4555-8555-555555555555', 'https://example.org/erased',
   public.contract_url_key('https://example.org/erased'), 'Erased fixture source', 'debunked', NULL, 'batch-fixture-1',
   'automation', 'cleanup-run-fixture', 0.42, 'claim-confidence-mean-v1', repeat('a', 64)),
  ('66666666-6666-4666-8666-666666666667', '55555555-5555-4555-8555-555555555556', 'https://example.org/lift-me',
   public.contract_url_key('https://example.org/lift-me'), 'Tombstone the run lifts', 'deliberate', 'removed on purpose', NULL,
   'user', NULL, NULL, NULL, NULL);
UPDATE public.source_tombstones SET eraser_user = 'fixture-operator' WHERE id = '66666666-6666-4666-8666-666666666667';
INSERT INTO public.source_trail_events (source_id, tombstone_id, kind, detail, actor) VALUES
  ('55555555-5555-4555-8555-555555555555', '66666666-6666-4666-8666-666666666666', 'erased', '{"reason_type": "debunked"}', 'cleanup-run-fixture');

-- A notification from a producer
INSERT INTO public.research_notifications (id, class, subject, slug, error, dedup_key) VALUES
  ('f0000000-0000-4000-8000-0000000000f1', 'transient', 'LLM call failing for this task: tool-fixture',
   'content/tool/tool-fixture', 'timeout after 3 retries', 'fixture-notification-1');

-- P2a (rw-p2a-refs): reference records. A source at revision 2 whose revision 1 is pinned by
-- one span reference (out of date; its quote is still in chunk 1) and revision 2 by another
-- (current, chunk 2); a legacy note holds both by id; a PDF source for the page+quad rule.
-- Texts avoid the words the P0 search tests query.
INSERT INTO public.sources (id, url, title, content, content_type, domain, metadata) VALUES
  ('f1000000-0000-4000-8000-000000000001', 'https://example.org/reference-fixture', 'Reference fixture source',
   'Opening line of the reference fixture. The quoted span about pinned anchors lives here. Closing line.',
   'web_article', 'example.org', '{}'),
  ('f1000000-0000-4000-8000-000000000002', 'https://example.org/reference-fixture.pdf', 'PDF reference fixture',
   'Page one text of the PDF fixture.', 'pdf', 'example.org', '{}');
INSERT INTO public.source_revisions (source_id, revision, content, title, edited_by) VALUES
  ('f1000000-0000-4000-8000-000000000001', 1, 'Opening line of the reference fixture. The quoted span about pinned anchors lives here.',
   'Reference fixture source', 'original'),
  ('f1000000-0000-4000-8000-000000000001', 2, 'Opening line of the reference fixture. The quoted span about pinned anchors lives here. Closing line.',
   'Reference fixture source', 'operator');
INSERT INTO public.source_chunks (source_id, idx, content) VALUES
  ('f1000000-0000-4000-8000-000000000001', 0, 'Opening line of the reference fixture.'),
  ('f1000000-0000-4000-8000-000000000001', 1, 'The quoted span about pinned anchors lives here.'),
  ('f1000000-0000-4000-8000-000000000001', 2, 'Closing line.'),
  ('f1000000-0000-4000-8000-000000000002', 0, 'Page one text of the PDF fixture.');
INSERT INTO public.reference_records (id, source_id, scope, selectors, provenance, pinned_revision, chunk_idx, created_by) VALUES
  ('f2000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000001', 'span',
   '{"quote": {"exact": "The quoted span about pinned anchors lives here.", "prefix": " line of the reference fixture. ", "suffix": ""},
     "position": {"start": 39, "end": 87}}', 'user', 1, 1, 'fixture'),
  ('f2000000-0000-4000-8000-000000000002', 'f1000000-0000-4000-8000-000000000001', 'span',
   '{"quote": {"exact": "Closing line.", "prefix": "bout pinned anchors lives here. ", "suffix": ""},
     "position": {"start": 88, "end": 101}}', 'assistant', 2, 2, 'fixture');
INSERT INTO public.reference_holders (holder_kind, holder_ref, reference_id, cited_ref, origin, seq, number) VALUES
  ('legacy_note', 'notes/p2a/fixture-note.md', 'f2000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000001', 'cited', 0, 1);
INSERT INTO public.reference_holders (holder_kind, holder_ref, reference_id, cited_ref, origin, seq, number) VALUES
  ('user_document', 'documents/fixture-refinery.md', 'f2000000-0000-4000-8000-000000000002', 'f1000000-0000-4000-8000-000000000001', 'added', 0, 1);
-- P2b (init-documents.sql): the fixture refinery picked its document's links up (the pick-up rule;
-- the context graph reads these, never the live listing)
INSERT INTO public.refinery_picked_links (refinery_id, node_kind, node_ref, reference_id, pin, owner_sub, actor_sub) VALUES
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1', 'source', '11111111-1111-4111-8111-111111111111', NULL, 2, 'operator', 'operator'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1', 'source', 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1', NULL, NULL, 'operator', 'operator'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1', 'page', 'content/tool/tool-fixture', NULL, NULL, 'operator', 'operator');
INSERT INTO public.reference_holder_state (holder_kind, holder_ref, content_sha256, migration) VALUES
  ('legacy_note', 'notes/p2a/fixture-note.md', NULL, '{"fixture": true}');

-- P7a (init-podcasts.sql): one team of two presenters with their voice links, one format, one
-- render of the operator's, one shared render of another user's, one render request.
INSERT INTO public.podcast_voice_links (id, owner_sub, route, voice, speed, origin) VALUES
  ('pod-fx-voice-a', 'operator', 'local-tts', 'bm_george', 1.0, 'operator'),
  ('pod-fx-voice-b', 'operator', 'local-tts', 'bf_emma', 1.0, 'operator');
INSERT INTO public.podcast_presenters (id, owner_sub, name, personality, backstory, language, voice_link_id, origin) VALUES
  ('pod-fx-presenter-a', 'operator', 'Fixture Alex', 'Analytical, asks probing questions', 'A researcher', 'en-US', 'pod-fx-voice-a', 'operator'),
  ('pod-fx-presenter-b', 'operator', 'Fixture Jamie', 'Enthusiastic and practical', 'An engineer', 'en-US', 'pod-fx-voice-b', 'operator');
INSERT INTO public.podcast_teams (id, owner_sub, name, description, origin) VALUES
  ('pod-fx-team', 'operator', 'fixture_team', 'Two fixture presenters', 'operator');
INSERT INTO public.podcast_team_members (team_id, position, presenter_id) VALUES
  ('pod-fx-team', 0, 'pod-fx-presenter-a'), ('pod-fx-team', 1, 'pod-fx-presenter-b');
INSERT INTO public.podcast_formats (id, owner_sub, name, description, team_id, briefing, segments, language, script_route, origin) VALUES
  ('pod-fx-format', 'operator', 'fixture_format', 'A fixture format', 'pod-fx-team', 'Discuss the fixture.', 3, 'en-US', 'local-large:nothink', 'operator');
INSERT INTO public.podcast_episodes (id, owner_sub, shared, title, team_id, audio_format, seconds, archive_dir, created_at) VALUES
  ('e7000000-0000-4000-8000-000000000001', 'operator', false, 'Fixture episode', 'pod-fx-team', 'mp3', 12.5, '/mounts/podcast-archive/renders/fixture', '2026-10-17T12:00:00Z'),
  ('e7000000-0000-4000-8000-000000000002', 'fixture-other-user', true, 'Shared fixture episode', NULL, 'mp3', 3.25, '/mounts/podcast-archive/renders/fixture-shared', '2026-10-17T11:00:00Z');
INSERT INTO public.podcast_render_requests (id, requester_sub, actor_sub, team_id, title, input, state, created_at, updated_at) VALUES
  ('e8000000-0000-4000-8000-000000000001', 'operator', 'operator', 'pod-fx-team', 'Fixture request',
   '{"transcript": {"title": "Fixture request", "turns": [{"presenterId": "pod-fx-presenter-a", "text": "Hello."}, {"presenterId": "pod-fx-presenter-b", "text": "Hi."}]}}',
   'queued', '2026-10-17T12:00:00Z', '2026-10-17T12:00:00Z');

COMMIT;
