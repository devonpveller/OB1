// Types for flags-fake.mjs (the shared fake flags back end), so the vitest suite type-checks.
export const REASONS: string[];
export const ITEM_KINDS: string[];
export const FROM_KINDS: string[];
export const STATES: string[];
export const ITEMS: { source: { id: string; title: string }[]; claim: { id: string; title: string }[]; reference: { id: string; title: string; heldBy?: string }[] };
export type FlagRowStored = {
  id: string; owner_sub: string; item_kind: string; item_id: string; reason: string; note: string;
  from_kind: string; from_ref: string; state: string; created_at: string; updated_at: string;
};
export function createFlagsFake(opts?: {
  ownsDocument?: (who: { sub: string; key: string }, path: string) => boolean;
  admins?: string[];
  now?: () => number;
}): {
  handle(who: { sub: string; key: string }, method: string, url: string, body?: any): { status: number; body: any } | null;
  reset(): void;
  rows(): FlagRowStored[];
  setAdmins(subs: string[]): void;
  plantSource(id: string): void;
  itemsSnapshot(): string;
};
export function documentPathsIn(s: string): string[];
export function singleDocumentPath(ref: string): string | null;
