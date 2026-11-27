// Types for gaps-fake.mjs (the shared fake gaps back end), so the vitest suite type-checks.
export const ORIGINS: string[];
export const STATES: string[];
export function normalizeGapText(s: string): string;
export function singleDocumentPath(path: string): string | null;
export type GapRowStored = {
  id: string; owner_sub: string; path: string; text: string; norm: string; origin: string; state: string;
  job_id: string | null; covered_at: string | null; created_at: string; updated_at: string;
};
export function createGapsFake(opts?: {
  ownsDocument?: (who: { sub: string; key: string }, path: string) => boolean;
  now?: () => number;
}): {
  handle(who: { sub: string; key: string }, method: string, url: string, body?: any): { status: number; body: any } | null;
  reset(): void;
  rows(): GapRowStored[];
  setQueue(v: "ok" | "off" | "fail"): void;
  finishRun(job: string, o?: { covers?: string[]; status?: string }): void;
  plantSession(s: { owner_sub: string; path: string; id: string; status?: string; created_at?: string; needs?: { need: string; status: string }[]; gaps?: string[] }): void;
  plantGap(owner: { sub: string }, g: { path: string; text: string; origin?: string; state?: string; job_id?: string | null; created_at?: string }): any;
};
