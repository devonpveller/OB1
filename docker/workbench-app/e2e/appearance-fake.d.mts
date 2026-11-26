// Types for appearance-fake.mjs (the shared fake settings back end), so the vitest suite type-checks.
export const OFFERED: { themes: string[]; accents: string[]; densities: string[]; text_sizes: string[] };
export type Key = { key: string; tier: string; type: string; section: string; position: number; label: string; help: string; default: unknown; env: string | null; read_by: string; validation: Record<string, any>; editable: boolean; tag: string };
export const REGISTRY: Key[];
export function problem(k: Key, value: unknown): string | null;
export type Fake = {
  store: Map<string, { value: unknown; version: number }>;
  tomb: Map<string, number>;
  wire: { sub: string; method: string; url: string; status: number; body: string }[];
  registry: Key[];
  plant(sub: string, key: string, value: unknown): void;
  handle(req: { method: string; url: string; sub: string; body?: any }): { status: number; body: any } | null;
};
export function createFake(): Fake;
