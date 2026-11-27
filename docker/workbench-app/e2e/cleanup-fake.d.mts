// Types for cleanup-fake.mjs (the shared fake Cleanup back end), so the vitest suite type-checks.
export const ERASURE_REASONS: string[];
export const DISMISSAL_KINDS: string[];
export const SRC: { ready1: string; ready2: string; ready3: string; blocked: string };
export const TOMB: { alice: string; bob: string };
export type FakeSource = {
  id: string; title: string; url: string | null; lifecycle: string; reason: string; suppressed_at: string; unlinked_at: string | null;
  counts: Record<string, number>; blocking: number; severable: number; total: number; erase_allowed: boolean;
};
export function createCleanupFake(opts?: { now?: () => number; flagReasons?: string[] }): {
  handle(who: { sub: string; key: string }, method: string, url: string, body?: any): { status: number; body: any } | null;
  reset(): void;
  sources(): FakeSource[];
  dismissals(): { id: string; owner_sub: string; kind: string; ref: string; created_at: string }[];
  tombs(): Record<string, any>;
  addSource(s: FakeSource): void;
};
