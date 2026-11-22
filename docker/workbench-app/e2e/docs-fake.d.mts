// Types for docs-fake.mjs (the shared fake documents back end), so the vitest suite type-checks.
export type Person = "alice" | "bob";
export const PEOPLE: Record<Person, { sub: string; key: string; name: string }>;
export type Doc = { owner: string; title: string; body: string; updated: string; links: { kind: string; id: string }[]; history: string[] };
export type FakeDb = { docs: Map<string, Doc>; folders: Set<string>; trail: { owner: string; kind: string; path: string; at: string }[] };
export function seed(now?: number): FakeDb;
export function createFake(opts?: { now?: () => number }): {
  handle(person: string, method: string, url: string, body?: Record<string, unknown>): { status: number; body: any } | null;
  reset(): void;
  db(): FakeDb;
  setClock(f: () => number): void;
};
