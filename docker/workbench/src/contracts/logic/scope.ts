// The caller's scope. A metadata filter (the cloud gateway forces {"share":"cloud"}) narrows
// every read to records whose metadata contains it; a record kind with no metadata to test
// returns nothing at all while a filter is present. Fail closed, never open.
export type MetadataFilter = Record<string, unknown> | null;

export class BadRequest extends Error {}

export function parseMetadataFilter(raw: string | undefined | null): MetadataFilter {
  if (raw === undefined || raw === null || raw.trim() === "") return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    throw new BadRequest("metadata_filter must be a JSON object");
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    throw new BadRequest("metadata_filter must be a JSON object");
  }
  return Object.keys(v as object).length ? v as Record<string, unknown> : null;
}

// For record kinds that carry no metadata (pages, sessions, ideas, documents, jobs): a present
// filter means an empty answer.
export function blocksMetadataless(f: MetadataFilter): boolean {
  return f !== null;
}

export function parseLimit(raw: string | undefined, def: number, max: number): number {
  const n = Number(raw ?? def);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(max, Math.max(1, Math.trunc(n)));
}

export function parseFlag(raw: string | undefined): boolean {
  return raw === "true";
}

export function parseList(raw: string | undefined): string[] {
  return (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}
