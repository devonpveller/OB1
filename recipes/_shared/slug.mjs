// Canonical slug algorithm — the SINGLE source of truth (plan §14.1, TASKS G5).
//
// One implementation imported by every layer that derives a slug, so a drift
// between copies can never silently break [[wikilink]] resolution:
//   * the recipe       — OB1/recipes/entity-wiki/generate-wiki.mjs
//   * the compiler      — OB1/docker/wiki-service/wiki-service.mjs
//   * the workbench     — OB1/docker/workbench/* (via the /recipes bind-mount)
//
// Algorithm: NFKD-normalize → strip combining marks → lowercase →
// collapse every run of non-[a-z0-9] to "-" → trim leading/trailing "-".
//
// Pure, dependency-free ESM so both Node (.mjs) and Deno can import it as-is.
// Do NOT fork a 4th/5th copy — extend HERE.

export function slugifyBase(name) {
  return String(name || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // combining diacritical marks
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Entity slug = "<type>-<base>" (e.g. "tool-postgresql"). Empty base → "unnamed"
// so a nameless entity still yields a stable, collision-resolvable filename.
// When `entityType` is falsy the base is returned alone.
export function slugifyEntity(name, entityType) {
  const base = slugifyBase(name) || "unnamed";
  return entityType ? `${entityType}-${base}` : base;
}

// Notebook / thread slug = base only (e.g. "my-research"). Empty → "default".
export function slugifyNotebook(name) {
  return slugifyBase(name) || "default";
}
