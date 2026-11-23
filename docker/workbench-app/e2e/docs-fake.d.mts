// Types for docs-fake.mjs (the shared fake documents back end), so the vitest suite type-checks.
export type Person = "alice" | "bob";
export const PEOPLE: Record<Person, { sub: string; key: string; name: string }>;
export type Doc = {
  id: string;          // the opaque id (the listing row's): stable through a move
  owner: string; title: string; body: string; updated: string; links: { kind: string; id: string }[]; history: string[];
  raw?: string;        // the whole file once a save wrote it (else its front matter + body)
  committed?: string;  // the file as of the last commit
  hdates?: string[];   // the date of each history line
};
export type Ref = { source_id: string; title: string; pinned_revision: number; current: number; chunk_idx: number | null; quote: string; chunks: string[]; held?: boolean };
export type FakeDb = {
  docs: Map<string, Doc>; folders: Set<string>; trail: { owner: string; kind: string; path: string; at: string }[];
  research: { job_id: string; owner: string; path: string; query: string; kind: string }[]; refs: Map<string, Ref>;
};
export const uid: (text: string) => string;
export const REF_A: string;
export const REF_B: string;
export const SRC_A: string;
export const REF_C: string;
export const SRC_C: string;
export function seed(now?: number): FakeDb;
export function createFake(opts?: { now?: () => number }): {
  handle(person: string, method: string, url: string, body?: Record<string, unknown>): { status: number; body: any } | null;
  reset(): void;
  db(): FakeDb;
  setClock(f: () => number): void;
};
