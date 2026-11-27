// Types for library-fake.mjs (the shared fake Library back end), so the vitest suite type-checks.
import type { createFake } from "./docs-fake.mjs";
export const KINDS: string[];
export const UI_KEYS: string[];
export const START_SCREENS: string[];
export const MAX_PER_DOCUMENT: number;
export const SRC: (n: number) => string;
export const SRC_HIDDEN: string;
export const SRC_CUT: string;
export const SRC_GONE: string;
export const SRC_HELD_A: string;
export const CLAIM_SHARED: string;
export const CLAIM_PRIVATE_A: string;
export const PRIVATE_MARKER: string;
export function settingProblem(key: string, value: unknown): string | null;
export type PendingRow = {
  id: string; owner: string; path: string; source_id: string | null; claim_id: string | null; section: string; quote: string; added_from: string; created_at: string;
};
export function createLibraryFake(opts: { docs: ReturnType<typeof createFake>; now?: () => number }): {
  handle(person: string, method: string, url: string, body?: any): { status: number; body: any; headers?: Record<string, string> } | null;
  reset(): void;
  setLifecycle(id: string, lifecycle: string): void;
  erase(id: string): void;
  rename(id: string, title: string): void;
  pendingRows(): PendingRow[];
  account(person: string): Record<string, { value: unknown; version: number }>;
  plantAccount(person: string, key: string, value: unknown): void;
  privateClaimOwner(id: string): string | null;
  sourceTitle(id: string): string | null;
};
