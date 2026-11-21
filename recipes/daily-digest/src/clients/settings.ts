/**
 * rw-settings-store (plan 08 PD3): the digest and the podcast read the RUN OWNER's settings through the
 * database's one read function, public.setting_get(owner, key) (init-settings.sql, slot 400), over
 * PostgREST (`/rest/v1/rpc/setting_get`, the same door as every other read here). NULL - nothing stored,
 * or a database / PostgREST without the function yet - means the env value this service has always used,
 * so nothing changes until a value is stored. Never throws: a settings read can never fail a digest or an
 * episode. Read on every run, so a stored value is what the NEXT run uses.
 *
 * rw-rest-door-auth (slot 450): the door call is rpc/rest_setting_get(p_key), which takes the owner from the
 * token's verified `sub`; setting_get itself is no longer reachable through the door.
 */

import { restAuthHeaders } from "./rest-auth.ts";

export class SettingReader {
  readonly #base: string;
  readonly #f: typeof fetch;
  readonly #auth: Record<string, string>;
  #warned = false;

  /** `token`: the caller's REST token; omitted = OPEN_BRAIN_REST_TOKEN (rest-auth.ts). */
  constructor(baseUrl: string, fetchFn?: typeof fetch, token?: string) {
    this.#base = baseUrl.replace(/\/+$/, "");
    this.#f = fetchFn ?? fetch;
    this.#auth = token === undefined ? restAuthHeaders() : (token.trim() ? { Authorization: `Bearer ${token.trim()}` } : {});
  }

  /** The owner's stored value, or null. */
  async get(owner: string, key: string): Promise<unknown> {
    if (!owner) return null;
    try {
      // rw-rest-door-auth: the owner is the one this service's token names (rest_setting_get reads the verified
      // claim; slot 450) - no owner travels in the request. `owner` only says whether this run has one.
      const res = await this.#f(`${this.#base}/rest/v1/rpc/rest_setting_get`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json", ...this.#auth },
        body: JSON.stringify({ p_key: key }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
      const v = await res.json();
      return v ?? null;
    } catch (e) {
      if (!this.#warned) {
        this.#warned = true;
        console.warn(`[settings] rest_setting_get unavailable (${(e as Error).message}): the env values are used`);
      }
      return null;
    }
  }

  /** A stored whole number in [min, max], else the fallback. */
  async int(owner: string, key: string, fallback: number, min: number, max: number): Promise<number> {
    const v = await this.get(owner, key);
    return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : fallback;
  }

  /** A stored non-empty text, else the fallback. */
  async text(owner: string, key: string, fallback: string): Promise<string> {
    const v = await this.get(owner, key);
    return typeof v === "string" && v.trim() ? v.trim() : fallback;
  }
}

/** The team that voices an owner's daily episode: their podcast.team, else PODCAST_TEAM (blank = no audio). */
export function podcastTeamFor(reader: SettingReader, owner: string, envTeam: string): Promise<string> {
  return reader.text(owner, "podcast.team", envTeam.trim());
}

/** The AI-news window of an owner's digest: their digest.window_hours, else DIGEST_WINDOW_HOURS. */
export function digestWindowFor(reader: SettingReader, owner: string, envHours: number): Promise<number> {
  return reader.int(owner, "digest.window_hours", envHours, 1, 168);
}
