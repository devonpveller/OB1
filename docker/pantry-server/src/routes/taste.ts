// pantry-taste routes: evaluations, preferences (propose / confirm), hypotheses, explored, guidance.
// The service stores and filters; it writes no prose and calls no model. Rules it enforces:
//   * an unconfirmed preference is invisible to /guidance (D6)
//   * nothing becomes `hard` except a statement that said hard; a confirm edit cannot promote
//   * a child's reaction is an exposure (cooldown + trend), never an adult preference (D15)
//   * guest data is never learned (D18): guest_context on a guidance call only excludes
//     allergens/avoid items for that call; a guest-meal evaluation records no exposures,
//     cannot be hypothesis evidence and is left out of recent_evaluations
import type { Hono } from "hono";
import type { Deps } from "../app.ts";
import { readBody } from "../app.ts";
import {
  activePeople, addDays, getSettings, HttpError, invalid, isObj, isUuid, lc, notFound, optBool, optNum, optStr,
  reqStr, todayStr, validateGuest, type Row,
} from "../core.ts";
import type { Qx } from "../db.ts";
import { CUISINE_CANDIDATES, TECHNIQUE_CANDIDATES } from "../taste.ts";

const STRENGTHS = ["hard", "contextual", "soft"];
const SCOPES = ["recipe", "theme", "always"];
const WHO = ["adult", "child", "all"];
const REACTIONS = ["refused", "tolerated", "liked"];
const DAY_MS = 86_400_000;

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v ?? null);

function optIso(v: unknown, field: string): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" || Number.isNaN(Date.parse(v))) throw invalid(`${field} must be an ISO-8601 time`);
  return new Date(v).toISOString();
}

function oneOf(v: unknown, allowed: string[], field: string, dflt?: string): string {
  if ((v === undefined || v === null) && dflt) return dflt;
  if (typeof v !== "string" || !allowed.includes(v)) throw invalid(`${field} must be one of ${allowed.join(", ")}`);
  return v;
}

const prefOut = (p: Row) => ({
  id: p.id, statement: p.statement, strength: p.strength, subject: p.subject, context: p.context,
  reason: p.reason, scope: p.scope, who: p.who, evidence: p.evidence, confirmed: p.confirmed, active: p.active,
  created_at: iso(p.created_at),
});
const PREF_COLS = `id, statement, strength, subject, context, reason, scope, who, evidence, confirmed, active, created_at`;

const hypOut = (h: Row) => ({
  id: h.id, statement: h.statement, support: h.support, against: h.against, last_tested: iso(h.last_tested),
  created_at: iso(h.created_at),
});
const HYP_COLS = `id, statement, support, against, last_tested, created_at`;

const evalOut = (e: Row) => ({
  id: e.id, cook_event_id: e.cook_event_id, recipe_id: e.recipe_id, theme: e.theme, rating: e.rating,
  liked: e.liked, why: e.why, change: e.change, who: e.who, curiosity_q: e.curiosity_q,
  curiosity_a: e.curiosity_a, at: iso(e.at),
});
const EVAL_COLS = `id, cook_event_id, recipe_id, theme, rating, liked, why, change, who, curiosity_q, curiosity_a, at`;

const exposureOut = (x: Row) => ({
  id: x.id, person_id: x.who, subject: x.subject, reaction: x.reaction, cook_event_id: x.cook_event_id, at: iso(x.at),
});

/** contextual needs the dish/preparation (context) or why (reason): that is the whole point of the class. */
function checkPref(p: { strength: string; context?: string | null; reason?: string | null }) {
  if (p.strength === "contextual" && !(p.context && p.context.trim()) && !(p.reason && p.reason.trim())) {
    throw invalid("a contextual preference needs a context and/or a reason (it blocks that context, not the ingredient)");
  }
}

async function existingEvaluationIds(t: Qx, uid: string, ids: string[]): Promise<void> {
  if (!ids.length) return;
  const rows = await t.q(`SELECT id FROM pantry_evaluations WHERE user_id = $1 AND id = ANY($2::uuid[])`, [uid, ids]);
  const have = new Set(rows.map((r) => r.id));
  const missing = ids.filter((i) => !have.has(i.toLowerCase()));
  if (missing.length) throw invalid("evidence names an evaluation that does not exist", { unknown: missing });
}

export function registerTaste(app: Hono, d: Deps) {
  // ---------------------------------------------------------------- evaluations
  app.post("/evaluations", async (c) => {
    const b = await readBody(c);
    if (!isUuid(b.cook_event_id)) throw invalid("cook_event_id (UUID) is required");
    const rating = optNum(b.rating, "rating");
    if (rating !== undefined && (!Number.isInteger(rating) || rating < 1 || rating > 5)) throw invalid("rating must be an integer 1-5");
    const liked = optBool(b.liked, "liked");
    const why = optStr(b.why, "why");
    const change = optStr(b.change, "change");
    const who = oneOf(b.who, WHO, "who");
    const cq = optStr(b.curiosity_q, "curiosity_q");
    const ca = optStr(b.curiosity_a, "curiosity_a");
    const exps: { person_id: string | null; subject: string; reaction: string; at: string | null }[] = [];
    if (b.exposures !== undefined && b.exposures !== null) {
      if (!Array.isArray(b.exposures)) throw invalid("exposures must be an array");
      b.exposures.forEach((x: unknown, n: number) => {
        if (!isObj(x)) throw invalid(`exposures[${n}] must be an object`);
        if (x.person_id !== undefined && x.person_id !== null && !isUuid(x.person_id)) throw invalid(`exposures[${n}].person_id must be a UUID`);
        exps.push({
          person_id: (x.person_id as string | undefined) ?? null,
          subject: reqStr(x.subject, `exposures[${n}].subject`),
          reaction: oneOf(x.reaction, REACTIONS, `exposures[${n}].reaction`),
          at: optIso(x.at, `exposures[${n}].at`) ?? null,
        });
      });
    }

    const alreadyEvaluated = (who: string, id: unknown) =>
      new HttpError(409, "already_evaluated", `that cook already has an evaluation for who="${who}"; nothing was written`, { evaluation_id: id });
    let out;
    try {
     out = await d.db.tx(async (t) => {
      const ev = (await t.q(
        `SELECT id, recipe_id, guest_context, undone_at FROM pantry_cook_events WHERE id = $1 AND user_id = $2 FOR UPDATE`,
        [b.cook_event_id, d.userId],
      ))[0];
      if (!ev) throw notFound("cook event");
      if (ev.undone_at) throw new HttpError(409, "already_undone", "that cook was undone; there is nothing to evaluate");
      const dupe = (await t.q(
        `SELECT id FROM pantry_evaluations WHERE cook_event_id = $1 AND who = $2 AND user_id = $3 LIMIT 1`,
        [ev.id, who, d.userId],
      ))[0];
      if (dupe) {
        throw alreadyEvaluated(who, dupe.id);
      }
      const guestMeal = ev.guest_context !== null && ev.guest_context !== undefined;

      // exposures are the CHILD's reactions; validate before writing anything
      for (const x of exps) {
        if (!x.person_id) continue;
        const p = (await t.q(`SELECT role FROM pantry_people WHERE id = $1 AND user_id = $2`, [x.person_id, d.userId]))[0];
        if (!p) throw notFound(`person ${x.person_id}`);
        if (p.role !== "child") throw invalid("exposures record the child's reactions; an adult's dislike is a preference statement");
      }

      const theme = ev.recipe_id
        ? (await t.q(`SELECT theme FROM recipes WHERE id = $1 AND user_id = $2`, [ev.recipe_id, d.userId]))[0]?.theme ?? null
        : null;
      const e = (await t.q(
        `INSERT INTO pantry_evaluations (user_id, cook_event_id, recipe_id, theme, rating, liked, why, change, who,
                                         curiosity_q, curiosity_a)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING ${EVAL_COLS}`,
        [d.userId, ev.id, ev.recipe_id, theme, rating ?? null, liked ?? null, why ?? null, change ?? null, who,
          cq ?? null, ca ?? null],
      ))[0];

      const exposures: Row[] = [];
      // Deterministic order (D15 cooldown = LATEST exposure): within one call each subject's exposures get
      // strictly increasing timestamps in submission order; ties across calls fall back to insertion order.
      const lastAt = new Map<string, number>();
      for (const x of exps) {
        const k = lc(x.subject);
        let ms = x.at ? Date.parse(x.at) : Date.now();
        const prev = lastAt.get(k);
        if (prev !== undefined && ms <= prev) ms = prev + 1;
        lastAt.set(k, ms);
        x.at = new Date(ms).toISOString();
      }
      // D18: what a guest meal teaches about the child is mixed with the guests' meal, so nothing is learned.
      if (!guestMeal) {
        for (const x of exps) {
          exposures.push((await t.q(
            `INSERT INTO pantry_exposures (user_id, who, subject, cook_event_id, reaction, at)
             VALUES ($1,$2,$3,$4,$5, $6::timestamptz) RETURNING id, who, subject, cook_event_id, reaction, at`,
            [d.userId, x.person_id, x.subject, ev.id, x.reaction, x.at],
          ))[0]);
        }
      }
      return {
        evaluation: { ...evalOut(e), guest_meal: guestMeal },
        exposures: exposures.map(exposureOut),
        ...(guestMeal && exps.length ? { exposures_skipped: { count: exps.length, reason: "guest_meal" } } : {}),
      };
     });
    } catch (e) {
      // The unique index (cook_event_id, who) is the real guard; FOR UPDATE + the SELECT above only make
      // the common case cheap. A racing twin lands here: the whole transaction rolled back, so look the
      // winner up on its own and answer exactly as the sequential duplicate does.
      // deno-postgres wraps a statement error in a TransactionError whose cause is the PostgresError.
      // deno-lint-ignore no-explicit-any
      const x = e as any;
      const code = x?.fields?.code ?? x?.code ?? x?.cause?.fields?.code;
      if (code !== "23505") throw e;
      const w = (await d.db.q(
        `SELECT id FROM pantry_evaluations WHERE cook_event_id = $1 AND who = $2 AND user_id = $3 LIMIT 1`,
        [b.cook_event_id, who, d.userId],
      ))[0];
      if (!w) throw e;
      throw alreadyEvaluated(who, w.id);
    }
    return c.json(out, 201);
  });

  // ---------------------------------------------------------------- preferences
  app.post("/preferences", async (c) => {
    const b = await readBody(c);
    if (!Array.isArray(b.statements) || b.statements.length === 0 || b.statements.length > 50) {
      throw invalid("statements must be a non-empty array (max 50)");
    }
    const rows = (b.statements as unknown[]).map((raw, n) => {
      const w = `statements[${n}]`;
      if (!isObj(raw)) throw invalid(`${w} must be an object`);
      const strength = oneOf(raw.strength, STRENGTHS, `${w}.strength`);
      const ev = raw.evidence === undefined || raw.evidence === null ? [] : raw.evidence;
      if (!Array.isArray(ev) || ev.some((x) => !isUuid(x))) throw invalid(`${w}.evidence must be an array of evaluation ids`);
      const r = {
        statement: reqStr(raw.statement, `${w}.statement`),
        strength,
        subject: reqStr(raw.subject, `${w}.subject`),
        context: optStr(raw.context, `${w}.context`) || null,
        reason: optStr(raw.reason, `${w}.reason`) || null,
        scope: oneOf(raw.scope, SCOPES, `${w}.scope`),
        who: oneOf(raw.who, WHO, `${w}.who`, "adult"),
        evidence: ev as string[],
      };
      checkPref(r);
      return r;
    });
    const proposed = await d.db.tx(async (t) => {
      await existingEvaluationIds(t, d.userId, rows.flatMap((r) => r.evidence));
      const out: Row[] = [];
      for (const r of rows) {
        out.push((await t.q(
          `INSERT INTO pantry_preferences (user_id, statement, strength, subject, context, reason, scope, who, evidence,
                                           confirmed, active)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,false,true) RETURNING ${PREF_COLS}`,
          [d.userId, r.statement, r.strength, r.subject, r.context, r.reason, r.scope, r.who, JSON.stringify(r.evidence)],
        ))[0]);
      }
      return out;
    });
    return c.json({ proposed: proposed.map(prefOut) }, 201);
  });

  app.post("/preferences/confirm", async (c) => {
    const b = await readBody(c);
    const ids = b.ids === undefined || b.ids === null ? [] : b.ids;
    const reject = b.reject === undefined || b.reject === null ? [] : b.reject;
    if (!Array.isArray(ids) || ids.some((x) => !isUuid(x))) throw invalid("ids must be an array of preference ids");
    if (!Array.isArray(reject) || reject.some((x) => !isUuid(x))) throw invalid("reject must be an array of preference ids");
    if (ids.length === 0 && reject.length === 0) throw invalid("give ids to confirm and/or reject");
    if (ids.some((x: string) => reject.includes(x))) throw invalid("an id cannot be both confirmed and rejected");
    const edits = b.edits === undefined || b.edits === null ? {} : b.edits;
    if (!isObj(edits)) throw invalid("edits must be an object keyed by preference id");
    for (const k of Object.keys(edits)) {
      if (!ids.includes(k)) throw invalid(`edits["${k}"]: only a preference listed in ids can be edited`);
      if (!isObj(edits[k])) throw invalid(`edits["${k}"] must be an object`);
    }

    const out = await d.db.tx(async (t) => {
      const confirmed: Row[] = [];
      const rejected: Row[] = [];
      for (const id of reject) {
        const r = (await t.q(
          `UPDATE pantry_preferences SET active = false, confirmed = false WHERE id = $1 AND user_id = $2 RETURNING ${PREF_COLS}`,
          [id, d.userId],
        ))[0];
        if (!r) throw notFound(`preference ${id}`);
        rejected.push(r);
      }
      for (const id of ids as string[]) {
        const cur = (await t.q(`SELECT ${PREF_COLS} FROM pantry_preferences WHERE id = $1 AND user_id = $2 FOR UPDATE`, [id, d.userId]))[0];
        if (!cur) throw notFound(`preference ${id}`);
        if (!cur.active) throw new HttpError(409, "rejected", "that preference was rejected; propose it again to change your mind");
        const e = (edits[id] ?? {}) as Row;
        const n = {
          statement: e.statement !== undefined ? reqStr(e.statement, "edits.statement") : cur.statement,
          strength: e.strength !== undefined ? oneOf(e.strength, STRENGTHS, "edits.strength") : cur.strength,
          subject: e.subject !== undefined ? reqStr(e.subject, "edits.subject") : cur.subject,
          context: e.context !== undefined ? optStr(e.context, "edits.context") || null : cur.context,
          reason: e.reason !== undefined ? optStr(e.reason, "edits.reason") || null : cur.reason,
          scope: e.scope !== undefined ? oneOf(e.scope, SCOPES, "edits.scope") : cur.scope,
          who: e.who !== undefined ? oneOf(e.who, WHO, "edits.who") : cur.who,
        };
        if (n.strength === "hard" && cur.strength !== "hard") {
          throw invalid("an edit cannot promote a preference to hard; hard needs its own explicit statement with strength hard");
        }
        checkPref(n);
        confirmed.push((await t.q(
          `UPDATE pantry_preferences SET statement=$3, strength=$4, subject=$5, context=$6, reason=$7, scope=$8, who=$9,
                  confirmed = true WHERE id = $1 AND user_id = $2 RETURNING ${PREF_COLS}`,
          [id, d.userId, n.statement, n.strength, n.subject, n.context, n.reason, n.scope, n.who],
        ))[0]);
      }
      return { confirmed: confirmed.map(prefOut), rejected: rejected.map(prefOut) };
    });
    return c.json(out);
  });

  app.get("/preferences", async (c) => {
    const where = ["user_id = $1"];
    const params: unknown[] = [d.userId];
    const active = c.req.query("active");
    if (active === "true" || active === "false") {
      params.push(active === "true");
      where.push(`active = $${params.length}`);
    }
    const confirmed = c.req.query("confirmed");
    if (confirmed === "true" || confirmed === "false") {
      params.push(confirmed === "true");
      where.push(`confirmed = $${params.length}`);
    }
    const who = c.req.query("who");
    if (who) {
      if (!WHO.includes(who)) throw invalid(`who must be one of ${WHO.join(", ")}`);
      params.push(who);
      where.push(`who = $${params.length}`);
    }
    const rows = await d.db.q(
      `SELECT ${PREF_COLS} FROM pantry_preferences WHERE ${where.join(" AND ")} ORDER BY created_at, id`,
      params,
    );
    return c.json({ preferences: rows.map(prefOut) });
  });

  // ---------------------------------------------------------------- hypotheses
  app.post("/hypotheses", async (c) => {
    const b = await readBody(c);
    const statement = reqStr(b.statement, "statement");
    const out = await d.db.tx(async (t) => {
      // ux_pantry_hypotheses_user_stmt (user_id, lower(statement)) makes this race-free: a parallel twin
      // waits for the first insert, then takes DO NOTHING and reads the winner (READ COMMITTED sees it).
      const ins = (await t.q(
        `INSERT INTO pantry_taste_hypotheses (user_id, statement) VALUES ($1,$2)
         ON CONFLICT (user_id, lower(statement)) DO NOTHING RETURNING ${HYP_COLS}`,
        [d.userId, statement],
      ))[0];
      if (ins) return { row: ins, created: true };
      return {
        row: (await t.q(
          `SELECT ${HYP_COLS} FROM pantry_taste_hypotheses WHERE user_id = $1 AND lower(statement) = lower($2)`,
          [d.userId, statement],
        ))[0],
        created: false,
      };
    });
    return c.json({ ...hypOut(out.row), duplicate: !out.created }, out.created ? 201 : 200);
  });

  app.post("/hypotheses/:id/evidence", async (c) => {
    const id = c.req.param("id");
    if (!isUuid(id)) throw notFound("hypothesis");
    const b = await readBody(c);
    if (typeof b.supports !== "boolean") throw invalid("supports (boolean) is required");
    if (!isUuid(b.evaluation_id)) throw invalid("evaluation_id (UUID) is required");
    const out = await d.db.tx(async (t) => {
      const h = (await t.q(`SELECT id FROM pantry_taste_hypotheses WHERE id = $1 AND user_id = $2 FOR UPDATE`, [id, d.userId]))[0];
      if (!h) throw notFound("hypothesis");
      const ev = (await t.q(
        `SELECT e.id, ce.guest_context, ce.undone_at FROM pantry_evaluations e
           JOIN pantry_cook_events ce ON ce.id = e.cook_event_id
          WHERE e.id = $1 AND e.user_id = $2`,
        [b.evaluation_id, d.userId],
      ))[0];
      if (!ev) throw notFound("evaluation");
      if (ev.undone_at) throw invalid("that evaluation belongs to an undone cook; it is not evidence", { reason: "cook_undone" });
      if (ev.guest_context !== null && ev.guest_context !== undefined) {
        throw invalid("that evaluation is of a guest meal; guest meals are never learned", { reason: "guest_meal" });
      }
      const upd = (await t.q(
        `UPDATE pantry_taste_hypotheses
            SET support = support + $3::int, against = against + $4::int, last_tested = now(),
                evidence = array_append(evidence, $5::uuid)
          WHERE id = $1 AND user_id = $2 AND NOT ($5::uuid = ANY(evidence)) RETURNING ${HYP_COLS}`,
        [id, d.userId, b.supports ? 1 : 0, b.supports ? 0 : 1, b.evaluation_id],
      ))[0];
      if (upd) return { row: upd, duplicate: false };
      // already counted for this hypothesis: change nothing
      return {
        row: (await t.q(`SELECT ${HYP_COLS} FROM pantry_taste_hypotheses WHERE id = $1 AND user_id = $2`, [id, d.userId]))[0],
        duplicate: true,
      };
    });
    return c.json({ ...hypOut(out.row), duplicate: out.duplicate });
  });

  app.get("/hypotheses", async (c) => {
    const rows = await d.db.q(
      `SELECT ${HYP_COLS} FROM pantry_taste_hypotheses WHERE user_id = $1 ORDER BY created_at, id`,
      [d.userId],
    );
    return c.json({ hypotheses: rows.map(hypOut) });
  });

  // ---------------------------------------------------------------- explored
  app.get("/explored", async (c) => {
    const rows = await d.db.q(
      `SELECT dimension, value, times, first_tried FROM pantry_explored WHERE user_id = $1 ORDER BY first_tried, value`,
      [d.userId],
    );
    const pick = (dim: string) =>
      rows.filter((r) => r.dimension === dim).map((r) => ({ value: r.value, times: r.times, first_tried: iso(r.first_tried) }));
    return c.json({ cuisines: pick("cuisine"), techniques: pick("technique"), ingredients: pick("ingredient") });
  });

  // ---------------------------------------------------------------- guidance
  app.post("/guidance", async (c) => {
    const b = await readBody(c);
    const theme = optStr(b.theme, "theme") || null;
    if (b.recipe_id !== undefined && b.recipe_id !== null && !isUuid(b.recipe_id)) throw invalid("recipe_id must be a UUID");
    const guest = validateGuest(b.guest_context);
    const nowIso = optIso(b.now, "now"); // test hook: evaluate the cooldown at an explicit instant
    const now = nowIso ? new Date(nowIso) : new Date();
    const uid = d.userId;
    const q: Qx = d.db;

    const settings = await getSettings(q, uid);

    // allergens: every ACTIVE person's allergies plus this meal's guests'. Never stored, never learned.
    const allergens: { allergen: string; who: string }[] = [];
    const seen = new Set<string>();
    const addAllergen = (allergen: string, who: string) => {
      const a = lc(allergen);
      if (!a || seen.has(a + "\u0000" + who)) return;
      seen.add(a + "\u0000" + who);
      allergens.push({ allergen: a, who });
    };
    for (const p of await activePeople(q, uid)) for (const a of p.allergies ?? []) addAllergen(a, p.label);
    for (const a of Array.isArray(guest?.allergies) ? (guest!.allergies as string[]) : []) addAllergen(a, "guest");
    const avoid = (Array.isArray(guest?.avoid) ? (guest!.avoid as string[]) : []).map(lc).filter(Boolean);

    // preferences: CONFIRMED and active only
    const prefs = (await q.q(
      `SELECT ${PREF_COLS} FROM pantry_preferences WHERE user_id = $1 AND confirmed AND active ORDER BY created_at, id`,
      [uid],
    )).map(prefOut);
    const byStrength = (s: string) => prefs.filter((p) => p.strength === s);
    const hardSubjects = new Set(byStrength("hard").map((p) => lc(p.subject)));

    // child exposures -> cooldowns + trends. Excludes guest meals and undone cooks.
    const exp = await q.q(
      `SELECT x.subject, x.reaction, x.at FROM pantry_exposures x
         LEFT JOIN pantry_cook_events ce ON ce.id = x.cook_event_id
         LEFT JOIN pantry_people p ON p.id = x.who
        WHERE x.user_id = $1
          AND (x.cook_event_id IS NULL OR (ce.undone_at IS NULL AND ce.guest_context IS NULL))
          AND (x.who IS NULL OR p.role = 'child')
        ORDER BY x.at, x.seq`,
      [uid],
    );
    const bySubject = new Map<string, Row[]>();
    for (const x of exp) {
      const k = lc(x.subject);
      if (!bySubject.has(k)) bySubject.set(k, []);
      bySubject.get(k)!.push(x);
    }
    const cooldowns: { subject: string; until: string }[] = [];
    const trends: Row[] = [];
    for (const rows of bySubject.values()) {
      const last = rows[rows.length - 1];
      const counts = { refused: 0, tolerated: 0, liked: 0 };
      for (const r of rows) counts[r.reaction as keyof typeof counts]++;
      trends.push({ subject: last.subject, exposures: counts, last_reaction: last.reaction, last_at: iso(last.at) });
      if (last.reaction === "refused") {
        const until = new Date((last.at as Date).getTime() + settings.child_cooldown_days * DAY_MS);
        if (until.getTime() > now.getTime()) cooldowns.push({ subject: last.subject, until: until.toISOString() });
      }
    }
    cooldowns.sort((a, b2) => a.until.localeCompare(b2.until) || a.subject.localeCompare(b2.subject));
    trends.sort((a, b2) => String(a.subject).localeCompare(String(b2.subject)));

    // hypotheses
    const hyps = (await q.q(
      `SELECT ${HYP_COLS} FROM pantry_taste_hypotheses WHERE user_id = $1 ORDER BY last_tested NULLS FIRST, created_at, id`,
      [uid],
    )).map(hypOut);

    // recent evaluations: for the recipe, else the theme, else the latest; never a guest meal or an undone cook
    const ev: string[] = [`e.user_id = $1`, `ce.undone_at IS NULL`, `ce.guest_context IS NULL`];
    const evp: unknown[] = [uid];
    if (b.recipe_id) {
      evp.push(b.recipe_id);
      ev.push(`e.recipe_id = $${evp.length}`);
    } else if (theme) {
      evp.push(theme);
      ev.push(`lower(e.theme) = lower($${evp.length})`);
    }
    const recent = (await q.q(
      `SELECT ${EVAL_COLS.split(", ").map((x) => "e." + x).join(", ")}, r.name AS recipe_name
         FROM pantry_evaluations e
         JOIN pantry_cook_events ce ON ce.id = e.cook_event_id
         LEFT JOIN recipes r ON r.id = e.recipe_id
        WHERE ${ev.join(" AND ")} ORDER BY e.at DESC, e.id LIMIT 10`,
      evp,
    )).map((r) => ({ ...evalOut(r), recipe_name: r.recipe_name }));

    // use-soon stock
    const limit = addDays(todayStr(), settings.use_soon_days);
    const useSoon = (await q.q(
      `SELECT id, name, kind, quantity::float8 AS quantity, unit, expires_on::text AS expires_on
         FROM pantry_items WHERE user_id = $1 AND removed_at IS NULL AND expires_on IS NOT NULL AND expires_on <= $2::date
        ORDER BY expires_on, lower(name)`,
      [uid, limit],
    )).map((r) => ({
      item_id: r.id, name: r.name, expires_on: r.expires_on, quantity: r.kind === "counted" ? r.quantity : null, unit: r.unit,
    }));

    // untried: tried values are excluded; nothing hard-excluded, allergen-bearing or guest-avoided is offered
    const explored = await q.q(`SELECT dimension, value FROM pantry_explored WHERE user_id = $1`, [uid]);
    const tried = (dim: string) => new Set(explored.filter((r) => r.dimension === dim).map((r) => r.value));
    const triedIng = tried("ingredient");
    const blocked = (v: string) => hardSubjects.has(v) || avoid.includes(v);
    const allergenSet = new Set(allergens.map((a) => a.allergen));
    const items = await q.q(
      `SELECT name, aliases, allergens FROM pantry_items
        WHERE user_id = $1 AND removed_at IS NULL AND kind = 'counted' AND quantity > 0 ORDER BY lower(name)`,
      [uid],
    );
    const untriedIngredients: string[] = [];
    for (const it of items) {
      const names = [lc(it.name), ...(it.aliases ?? []).map(lc)];
      if (names.some((n) => triedIng.has(n) || blocked(n))) continue;
      if ((it.allergens ?? []).some((a: string) => allergenSet.has(lc(a)))) continue;
      untriedIngredients.push(it.name);
      if (untriedIngredients.length >= 30) break;
    }
    const triedCu = tried("cuisine");
    const triedTe = tried("technique");

    return c.json({
      allergens_excluded: allergens,
      ...(avoid.length ? { avoid_excluded: avoid } : {}),
      hard: byStrength("hard"),
      contextual: byStrength("contextual"),
      soft: byStrength("soft"),
      child_cooldowns: cooldowns,
      child_trends: trends,
      hypotheses: hyps,
      recent_evaluations: recent,
      use_soon: useSoon,
      untried: {
        cuisines: CUISINE_CANDIDATES.filter((v) => !triedCu.has(v) && !blocked(v)),
        techniques: TECHNIQUE_CANDIDATES.filter((v) => !triedTe.has(v) && !blocked(v)),
        ingredients: untriedIngredients,
      },
    });
  });
}
