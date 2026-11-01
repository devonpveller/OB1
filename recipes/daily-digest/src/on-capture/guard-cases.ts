// The read-only guard's bypass attempts (capture-fix round 2, tester t-p7a-capture D1 and its probe
// script journal/evidence/rw-p7a-tts/capture-fix/tester/probes/guard-probe.ts). Every one must be REFUSED by
// assertReadOnly; the real-SurrealDB test also sends any statement the guard admits and checks that no write
// lands. Shared by on-capture.test.ts (unit) and fingerprint.surreal.test.ts (a throwaway SurrealDB).
export const BYPASS_CASES: [string, string][] = [
  // the tester's repros: a quote OUTSIDE a literal used to open a fake literal that hid real code
  ["/* ' */ quote-in-comment hides fn::w()", "SELECT x /* ' */, fn::w() AS q /* ' */ FROM a"],
  ["-- ' quote-in-comment hides fn::w()", "SELECT x -- '\n, fn::w() AS q -- '\nFROM a"],
  ["# ' quote-in-comment hides fn::w()", "SELECT x # '\n, fn::w() AS q # '\nFROM a"],
  ["// ' quote-in-comment hides fn::w()", "SELECT x // '\n, fn::w() AS q // '\nFROM a"],
  ["/* ' */ hides a 2nd statement", "SELECT x FROM a /* ' */; CREATE pwned SET via = 'stmt2'; /* ' */"],
  ["/* ' */ hides a CREATE subquery", "SELECT x, (CREATE pwned SET via = 'sub') AS q /* ' */ FROM a /* ' */"],
  ["backtick ident with ' hides fn::w()", "SELECT `'` , fn::w() AS q, `'` FROM a"],
  ["angle ident with ' hides fn::w()", "SELECT ⟨'⟩, fn::w() AS q, ⟨'⟩ FROM a"],
  ["double-quote in a comment", 'SELECT x /* " */, fn::w() AS q /* " */ FROM a'],
  ["escaped quote then fn", "SELECT 'a\\'' , fn::w() FROM a"],
  ["unterminated literal", "SELECT 'abc FROM a"],
  // comments and identifiers of any kind, even harmless-looking
  ["-- comment", "SELECT x FROM a -- fn::w()"],
  ["/* */ comment", "SELECT x /* fn::w() */ FROM a"],
  ["comment between crypto and ::", "SELECT crypto/**/::sha256(x) FROM a"],
  ["a plain backtick identifier", "SELECT `x` FROM a"],
  ["a plain angle identifier", "SELECT ⟨x⟩ FROM a"],
  // statement separators
  ["2nd statement after ;", "SELECT crypto::sha256(x) FROM a; CREATE pwned SET v = 1"],
  ["a trailing ;", "SELECT x FROM a;"],
  ["; inside a literal then a real one", "SELECT crypto::sha256('x;') FROM a; SELECT 1"],
  // homoglyphs and invisible characters outside a literal
  ["U+2236 ratio as ::", "SELECT fn∶∶w() FROM a"],
  ["fullwidth colon", "SELECT crypto：：sha256(x) FROM a"],
  ["cyrillic c in crypto", "SELECT сrypto::sha256(x) FROM a"],
  ["zero-width space inside ::", "SELECT fn:​:w() FROM a"],
  ["a NUL outside a literal", "SELECT x\u0000 FROM a"],
  // function calls (round 1/2 rules, kept)
  ["fn:: call", "SELECT fn::w() FROM a"],
  ["sha256 over fn", "SELECT crypto::sha256(fn::w()) FROM a"],
  ["sha256x", "SELECT crypto::sha256x(x) FROM a"],
  ["sha256 over (CREATE ...)", "SELECT crypto::sha256(<string> (CREATE pwned SET via = 'x')) FROM a"],
  ["literal holding crypto::sha256( then fn::", "SELECT 'crypto::sha256(' , fn::w() FROM a"],
];

/** Statements the capture itself sends - each must be ADMITTED. */
export const CAPTURE_QUERIES: string[] = [
  "INFO FOR NS", "INFO FOR DB", "INFO FOR TABLE source_embedding",
  "SELECT id, crypto::sha256(<string> $this) AS h FROM source ORDER BY id LIMIT 200 START 0",
  "SELECT * FROM speaker_profile", "SELECT * FROM episode_profile", "SELECT * FROM podcast_config",
  "SELECT id, name, type, provider, credential FROM model", "SELECT * FROM episode",
  "SELECT id, name, status, args, error_message FROM command WHERE name = 'generate_podcast'",
];
