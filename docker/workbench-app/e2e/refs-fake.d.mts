// Types for refs-fake.mjs (the References tab's fake back end, layered over docs-fake.mjs), so the vitest suite type-checks.
import type { FakeDb } from "./docs-fake.mjs";
export type Person = "alice" | "bob";
export const PEOPLE: Record<Person, { sub: string; key: string; name: string }>;
export const CPU: string;
export const BRAVO: string;
export const S_SOCKET: string;
export const S_POWER: string;
export const S_COOL: string;
export const S_NEW: string;
export const S_DRIFT: string;
export const S_BARE: string;
export const S_LONG: string;
export const S_BRAVO: string;
export const C_POWER: string;
export const C_ORPHAN: string;
export const REF_SOCKET: string;
export const REF_POWER: string;
export const REF_COOL: string;
export const REF_DRIFT: string;
export type RefsState = {
  sources: Map<string, { title: string; held: boolean; hidden?: boolean; owner: string | null; revs: { rev: number; content: string }[] }>;
  records: Map<string, { id: string; source_id: string; pinned_revision: number; selectors: { quote: { exact: string } } }>;
  holders: Map<string, { origin: string; seq: number; reference_id: string }[]>;
  pending: Map<string, { id: string; owner: string; path: string; source_id: string | null; claim_id: string | null; section: string; quote: string; added_from: string }>;
};
export function createRefsFake(opts?: { now?: () => number }): {
  handle(person: string, method: string, url: string, body?: Record<string, unknown>): { status: number; body: any } | null;
  reset(): void;
  db(): FakeDb & { refs: RefsState };
  addRevision(sourceId: string, content: string): void;
  state(): RefsState;
};
