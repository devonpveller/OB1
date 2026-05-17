/**
 * Open Brain Extensions — combined MCP server (offline / self-hosted).
 *
 * Hosts all six OB1 extensions in one server, talking directly to
 * PostgreSQL + pgvector instead of Supabase:
 *   1. household-knowledge   2. home-maintenance   3. family-calendar
 *   4. meal-planning         5. professional-crm   6. job-hunt
 *
 * Tool names, descriptions and input schemas mirror the upstream
 * extensions verbatim; only the data-access layer is rewritten as raw SQL.
 *
 * Env: DB_HOST DB_PORT DB_NAME DB_USER DB_PASSWORD DEFAULT_USER_ID
 *      MCP_ACCESS_KEY PORT
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { Hono } from "hono";
import { z } from "zod";
import { Pool } from "postgres";

const pool = new Pool({
  hostname: Deno.env.get("DB_HOST") || "openbrain-db",
  port: parseInt(Deno.env.get("DB_PORT") || "5432", 10),
  database: Deno.env.get("DB_NAME") || "openbrain",
  user: Deno.env.get("DB_USER") || "postgres",
  password: Deno.env.get("DB_PASSWORD")!,
}, 10);

const USER_ID = Deno.env.get("DEFAULT_USER_ID")!;
const MCP_ACCESS_KEY = Deno.env.get("MCP_ACCESS_KEY")!;

// Compiled wiki (read-only). Markdown pages + graph.json live on a
// shared volume written by the openbrain-wiki compiler service.
// WIKI_RECOMPILE_URL is that service's on-demand trigger endpoint.
const WIKI_DIR = Deno.env.get("WIKI_DIR") || "/wiki/content";
const WIKI_RECOMPILE_URL = Deno.env.get("WIKI_RECOMPILE_URL") || "";

if (!/^[0-9a-f-]{36}$/i.test(USER_ID)) {
  console.error("DEFAULT_USER_ID is not a valid UUID:", USER_ID);
}

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

async function q<T = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
  const client = await pool.connect();
  try {
    const r = await client.queryObject<T>(sql, params);
    return r.rows;
  } finally {
    client.release();
  }
}

const ok = (obj: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }],
});
const fail = (e: unknown) => ({
  content: [{
    type: "text" as const,
    text: JSON.stringify({
      success: false,
      error: e instanceof Error ? e.message : String(e),
    }),
  }],
  isError: true,
});

/**
 * Generic INSERT ... RETURNING *. `casts` maps column -> pg type
 * ("jsonb" | "text[]" | ...). jsonb values are JSON.stringified.
 */
async function insertRow(
  table: string,
  obj: Record<string, unknown>,
  casts: Record<string, string> = {},
): Promise<Row> {
  const keys = Object.keys(obj);
  const cols = keys.join(", ");
  const ph = keys
    .map((k, i) => (casts[k] ? `$${i + 1}::${casts[k]}` : `$${i + 1}`))
    .join(", ");
  const vals = keys.map((k) =>
    casts[k] === "jsonb" ? JSON.stringify(obj[k] ?? null) : obj[k]
  );
  const rows = await q(
    `INSERT INTO ${table} (${cols}) VALUES (${ph}) RETURNING *`,
    vals,
  );
  return rows[0];
}

/** UPDATE ... SET ... WHERE id=$ [AND user_id=$] RETURNING * */
async function updateById(
  table: string,
  id: string,
  obj: Record<string, unknown>,
  opts: { casts?: Record<string, string>; scopeUser?: boolean } = {},
): Promise<Row> {
  const casts = opts.casts ?? {};
  const keys = Object.keys(obj);
  const set = keys
    .map((k, i) => `${k} = $${i + 1}${casts[k] ? `::${casts[k]}` : ""}`)
    .join(", ");
  const vals = keys.map((k) =>
    casts[k] === "jsonb" ? JSON.stringify(obj[k] ?? null) : obj[k]
  );
  vals.push(id);
  let sql =
    `UPDATE ${table} SET ${set} WHERE id = $${keys.length + 1}`;
  if (opts.scopeUser !== false) {
    vals.push(USER_ID);
    sql += ` AND user_id = $${keys.length + 2}`;
  }
  const rows = await q(`${sql} RETURNING *`, vals);
  if (!rows[0]) throw new Error("Row not found or access denied");
  return rows[0];
}

const server = new McpServer({ name: "open-brain-extensions", version: "1.0.0" });

/* ===========================================================================
 * Extension 1: Household Knowledge Base
 * ========================================================================= */

server.tool(
  "add_household_item",
  "Add a new household item (paint color, appliance, measurement, document, etc.)",
  {
    name: z.string().describe("Name or description of the item"),
    category: z.string().optional().describe("Category (e.g. 'paint', 'appliance', 'measurement', 'document')"),
    location: z.string().optional().describe("Location in the home (e.g. 'Living Room', 'Kitchen')"),
    details: z.string().optional().describe("Flexible metadata as JSON string"),
    notes: z.string().optional().describe("Additional notes or context"),
  },
  async ({ name, category, location, details, notes }) => {
    try {
      let detailsVal: unknown = {};
      if (details) {
        try { detailsVal = JSON.parse(details); } catch { detailsVal = { raw: details }; }
      }
      const item = await insertRow("household_items", {
        user_id: USER_ID,
        name,
        category: category ?? null,
        location: location ?? null,
        details: detailsVal,
        notes: notes ?? null,
      }, { details: "jsonb" });
      return ok({ success: true, message: `Added household item: ${name}`, item });
    } catch (e) { return fail(e); }
  },
);

server.tool(
  "search_household_items",
  "Search household items by name, category, or location",
  {
    query: z.string().optional().describe("Search term (searches name, category, location, and notes)"),
    category: z.string().optional().describe("Filter by specific category"),
    location: z.string().optional().describe("Filter by specific location"),
  },
  async ({ query, category, location }) => {
    try {
      const cond = ["user_id = $1"];
      const params: unknown[] = [USER_ID];
      if (category) { params.push(`%${category}%`); cond.push(`category ILIKE $${params.length}`); }
      if (location) { params.push(`%${location}%`); cond.push(`location ILIKE $${params.length}`); }
      if (query) {
        params.push(`%${query}%`);
        const p = `$${params.length}`;
        cond.push(`(name ILIKE ${p} OR category ILIKE ${p} OR location ILIKE ${p} OR notes ILIKE ${p})`);
      }
      const items = await q(
        `SELECT * FROM household_items WHERE ${cond.join(" AND ")} ORDER BY created_at DESC`,
        params,
      );
      return ok({ success: true, count: items.length, items });
    } catch (e) { return fail(e); }
  },
);

server.tool(
  "get_item_details",
  "Get full details of a specific household item by ID",
  { item_id: z.string().describe("Item ID (UUID)") },
  async ({ item_id }) => {
    try {
      const rows = await q(
        `SELECT * FROM household_items WHERE id = $1 AND user_id = $2`,
        [item_id, USER_ID],
      );
      if (!rows[0]) throw new Error("Item not found or access denied");
      return ok({ success: true, item: rows[0] });
    } catch (e) { return fail(e); }
  },
);

server.tool(
  "add_vendor",
  "Add a service provider (plumber, electrician, landscaper, etc.)",
  {
    name: z.string().describe("Vendor name"),
    service_type: z.string().optional().describe("Type of service"),
    phone: z.string().optional().describe("Phone number"),
    email: z.string().optional().describe("Email address"),
    website: z.string().optional().describe("Website URL"),
    notes: z.string().optional().describe("Additional notes"),
    rating: z.number().min(1).max(5).optional().describe("Rating from 1-5"),
    last_used: z.string().optional().describe("Date last used (YYYY-MM-DD)"),
  },
  async (a) => {
    try {
      const vendor = await insertRow("household_vendors", {
        user_id: USER_ID,
        name: a.name,
        service_type: a.service_type ?? null,
        phone: a.phone ?? null,
        email: a.email ?? null,
        website: a.website ?? null,
        notes: a.notes ?? null,
        rating: a.rating ?? null,
        last_used: a.last_used ?? null,
      });
      return ok({ success: true, message: `Added vendor: ${a.name}`, vendor });
    } catch (e) { return fail(e); }
  },
);

server.tool(
  "list_vendors",
  "List service providers, optionally filtered by service type",
  { service_type: z.string().optional().describe("Filter by service type") },
  async ({ service_type }) => {
    try {
      const params: unknown[] = [USER_ID];
      let sql = `SELECT * FROM household_vendors WHERE user_id = $1`;
      if (service_type) { params.push(`%${service_type}%`); sql += ` AND service_type ILIKE $2`; }
      sql += ` ORDER BY name ASC`;
      const vendors = await q(sql, params);
      return ok({ success: true, count: vendors.length, vendors });
    } catch (e) { return fail(e); }
  },
);

/* ===========================================================================
 * Extension 2: Home Maintenance Tracker
 * ========================================================================= */

server.tool(
  "add_maintenance_task",
  "Create a new maintenance task (recurring or one-time)",
  {
    name: z.string().describe("Name of the maintenance task"),
    category: z.string().optional().describe("Category (e.g. 'hvac', 'plumbing', 'exterior')"),
    frequency_days: z.number().optional().describe("How often this task repeats (in days)"),
    next_due: z.string().optional().describe("When this task is next due (ISO 8601 date)"),
    priority: z.enum(["low", "medium", "high", "urgent"]).optional().describe("Priority level"),
    notes: z.string().optional().describe("Additional notes about this task"),
  },
  async (a) => {
    try {
      const task = await insertRow("maintenance_tasks", {
        user_id: USER_ID,
        name: a.name,
        category: a.category ?? null,
        frequency_days: a.frequency_days ?? null,
        next_due: a.next_due ?? null,
        priority: a.priority ?? "medium",
        notes: a.notes ?? null,
      });
      return ok({ success: true, message: `Added maintenance task: ${a.name}`, task });
    } catch (e) { return fail(e); }
  },
);

server.tool(
  "log_maintenance",
  "Log that a maintenance task was completed. Automatically updates task's last_completed and calculates next_due.",
  {
    task_id: z.string().describe("ID of the maintenance task (UUID)"),
    completed_at: z.string().optional().describe("When the work was completed (ISO 8601)"),
    performed_by: z.string().optional().describe("Who performed the work"),
    cost: z.number().optional().describe("Cost in dollars"),
    notes: z.string().optional().describe("Notes about the work performed"),
    next_action: z.string().optional().describe("Recommendations for next time"),
  },
  async (a) => {
    try {
      const log = await insertRow("maintenance_logs", {
        task_id: a.task_id,
        user_id: USER_ID,
        completed_at: a.completed_at ?? new Date().toISOString(),
        performed_by: a.performed_by ?? null,
        cost: a.cost ?? null,
        notes: a.notes ?? null,
        next_action: a.next_action ?? null,
      });
      // DB trigger updates the parent task; fetch it back.
      const task = (await q(`SELECT * FROM maintenance_tasks WHERE id = $1`, [a.task_id]))[0];
      return ok({ success: true, message: "Maintenance logged successfully", log, updated_task: task });
    } catch (e) { return fail(e); }
  },
);

server.tool(
  "get_upcoming_maintenance",
  "List maintenance tasks due in the next N days",
  { days_ahead: z.number().optional().describe("Number of days to look ahead (default 30)") },
  async ({ days_ahead = 30 }) => {
    try {
      const tasks = await q(
        `SELECT * FROM maintenance_tasks
         WHERE user_id = $1 AND next_due IS NOT NULL
           AND next_due <= now() + ($2 || ' days')::interval
         ORDER BY next_due ASC`,
        [USER_ID, String(days_ahead)],
      );
      return ok({ success: true, days_ahead, count: tasks.length, tasks });
    } catch (e) { return fail(e); }
  },
);

server.tool(
  "search_maintenance_history",
  "Search maintenance logs by task name, category, or date range",
  {
    task_name: z.string().optional().describe("Filter by task name (partial match)"),
    category: z.string().optional().describe("Filter by category"),
    date_from: z.string().optional().describe("Start date (ISO 8601)"),
    date_to: z.string().optional().describe("End date (ISO 8601)"),
  },
  async (a) => {
    try {
      const cond = ["l.user_id = $1"];
      const params: unknown[] = [USER_ID];
      if (a.task_name) { params.push(`%${a.task_name}%`); cond.push(`t.name ILIKE $${params.length}`); }
      if (a.category) { params.push(`%${a.category}%`); cond.push(`t.category ILIKE $${params.length}`); }
      if (a.date_from) { params.push(a.date_from); cond.push(`l.completed_at >= $${params.length}`); }
      if (a.date_to) { params.push(a.date_to); cond.push(`l.completed_at <= $${params.length}`); }
      const logs = await q(
        `SELECT l.*, jsonb_build_object('id', t.id, 'name', t.name, 'category', t.category) AS maintenance_tasks
         FROM maintenance_logs l
         JOIN maintenance_tasks t ON t.id = l.task_id
         WHERE ${cond.join(" AND ")}
         ORDER BY l.completed_at DESC`,
        params,
      );
      return ok({ success: true, count: logs.length, logs });
    } catch (e) { return fail(e); }
  },
);

/* ===========================================================================
 * Extension 3: Family Calendar
 * ========================================================================= */

const FM_JOIN =
  `CASE WHEN fm.id IS NULL THEN NULL ELSE jsonb_build_object('name', fm.name, 'relationship', fm.relationship) END AS family_members`;

server.tool(
  "add_family_member",
  "Add a person to your household roster",
  {
    name: z.string().describe("Person's name"),
    relationship: z.string().optional().describe("Relationship (e.g. 'spouse', 'child')"),
    birth_date: z.string().optional().describe("Birth date (YYYY-MM-DD)"),
    notes: z.string().optional().describe("Additional notes"),
  },
  async (a) => {
    try {
      const row = await insertRow("family_members", {
        user_id: USER_ID,
        name: a.name,
        relationship: a.relationship ?? null,
        birth_date: a.birth_date ?? null,
        notes: a.notes ?? null,
      });
      return ok(row);
    } catch (e) { return fail(e); }
  },
);

server.tool(
  "add_activity",
  "Schedule an activity or recurring event",
  {
    family_member_id: z.string().optional().describe("Family member ID (null for whole family)"),
    title: z.string().describe("Activity title"),
    activity_type: z.string().optional().describe("Type: 'sports', 'medical', 'school', 'social'"),
    day_of_week: z.string().optional().describe("For recurring: 'monday' etc. Null for one-time"),
    start_time: z.string().optional().describe("Start time (HH:MM)"),
    end_time: z.string().optional().describe("End time (HH:MM)"),
    start_date: z.string().optional().describe("Start date (YYYY-MM-DD)"),
    end_date: z.string().optional().describe("End date (YYYY-MM-DD)"),
    location: z.string().optional().describe("Location"),
    notes: z.string().optional().describe("Additional notes"),
  },
  async (a) => {
    try {
      const row = await insertRow("activities", {
        user_id: USER_ID,
        family_member_id: a.family_member_id ?? null,
        title: a.title,
        activity_type: a.activity_type ?? null,
        day_of_week: a.day_of_week ?? null,
        start_time: a.start_time ?? null,
        end_time: a.end_time ?? null,
        start_date: a.start_date ?? null,
        end_date: a.end_date ?? null,
        location: a.location ?? null,
        notes: a.notes ?? null,
      });
      return ok(row);
    } catch (e) { return fail(e); }
  },
);

server.tool(
  "get_week_schedule",
  "Get all activities for a given week, grouped by day",
  {
    week_start: z.string().describe("Monday of the week (YYYY-MM-DD)"),
    family_member_id: z.string().optional().describe("Optional: filter by family member"),
  },
  async (a) => {
    try {
      const weekEnd = new Date(a.week_start);
      weekEnd.setDate(weekEnd.getDate() + 7);
      const weekEndStr = weekEnd.toISOString().split("T")[0];
      const params: unknown[] = [USER_ID, weekEndStr, a.week_start];
      let sql =
        `SELECT act.*, ${FM_JOIN}
         FROM activities act
         LEFT JOIN family_members fm ON fm.id = act.family_member_id
         WHERE act.user_id = $1
           AND ((act.start_date <= $2 AND (act.end_date >= $3 OR act.end_date IS NULL))
                OR act.day_of_week IS NOT NULL)`;
      if (a.family_member_id) {
        params.push(a.family_member_id);
        sql += ` AND act.family_member_id = $4`;
      }
      sql += ` ORDER BY act.start_time`;
      return ok(await q(sql, params));
    } catch (e) { return fail(e); }
  },
);

server.tool(
  "search_activities",
  "Search activities by title, type, or family member name",
  {
    query: z.string().optional().describe("Search query"),
    activity_type: z.string().optional().describe("Optional: filter by activity type"),
    family_member_id: z.string().optional().describe("Optional: filter by family member"),
  },
  async (a) => {
    try {
      const cond = ["act.user_id = $1"];
      const params: unknown[] = [USER_ID];
      if (a.query) { params.push(`%${a.query}%`); cond.push(`act.title ILIKE $${params.length}`); }
      if (a.activity_type) { params.push(a.activity_type); cond.push(`act.activity_type = $${params.length}`); }
      if (a.family_member_id) { params.push(a.family_member_id); cond.push(`act.family_member_id = $${params.length}`); }
      const rows = await q(
        `SELECT act.*, ${FM_JOIN}
         FROM activities act
         LEFT JOIN family_members fm ON fm.id = act.family_member_id
         WHERE ${cond.join(" AND ")}
         ORDER BY act.start_date DESC`,
        params,
      );
      return ok(rows);
    } catch (e) { return fail(e); }
  },
);

server.tool(
  "add_important_date",
  "Add a date to remember (birthday, anniversary, deadline)",
  {
    family_member_id: z.string().optional().describe("Family member ID (null for family-wide)"),
    title: z.string().describe("Event title"),
    date_value: z.string().describe("Date (YYYY-MM-DD)"),
    recurring_yearly: z.boolean().optional().describe("Does this repeat every year?"),
    reminder_days_before: z.number().optional().describe("Days before to remind (default 7)"),
    notes: z.string().optional().describe("Additional notes"),
  },
  async (a) => {
    try {
      const row = await insertRow("important_dates", {
        user_id: USER_ID,
        family_member_id: a.family_member_id ?? null,
        title: a.title,
        date_value: a.date_value,
        recurring_yearly: a.recurring_yearly ?? false,
        reminder_days_before: a.reminder_days_before ?? 7,
        notes: a.notes ?? null,
      });
      return ok(row);
    } catch (e) { return fail(e); }
  },
);

server.tool(
  "get_upcoming_dates",
  "Get important dates in the next N days",
  { days_ahead: z.number().optional().describe("How many days to look ahead (default 30)") },
  async ({ days_ahead = 30 }) => {
    try {
      const rows = await q(
        `SELECT idt.*, ${FM_JOIN}
         FROM important_dates idt
         LEFT JOIN family_members fm ON fm.id = idt.family_member_id
         WHERE idt.user_id = $1
           AND idt.date_value >= CURRENT_DATE
           AND idt.date_value <= CURRENT_DATE + ($2 || ' days')::interval
         ORDER BY idt.date_value`,
        [USER_ID, String(days_ahead)],
      );
      return ok(rows);
    } catch (e) { return fail(e); }
  },
);

/* ===========================================================================
 * Extension 4: Meal Planning
 * ========================================================================= */

server.tool(
  "add_recipe",
  "Add a recipe with ingredients and instructions",
  {
    name: z.string().describe("Recipe name"),
    cuisine: z.string().optional().describe("Cuisine type"),
    prep_time_minutes: z.number().optional().describe("Prep time in minutes"),
    cook_time_minutes: z.number().optional().describe("Cook time in minutes"),
    servings: z.number().optional().describe("Number of servings"),
    ingredients: z.array(z.object({ name: z.string(), quantity: z.string(), unit: z.string() }))
      .describe("Array of ingredient objects"),
    instructions: z.array(z.string()).describe("Array of instruction strings"),
    tags: z.array(z.string()).optional().describe("Tags for categorization"),
    rating: z.number().optional().describe("Rating 1-5"),
    notes: z.string().optional().describe("Additional notes"),
  },
  async (a) => {
    try {
      const row = await insertRow("recipes", {
        user_id: USER_ID,
        name: a.name,
        cuisine: a.cuisine ?? null,
        prep_time_minutes: a.prep_time_minutes ?? null,
        cook_time_minutes: a.cook_time_minutes ?? null,
        servings: a.servings ?? null,
        ingredients: a.ingredients,
        instructions: a.instructions,
        tags: a.tags ?? [],
        rating: a.rating ?? null,
        notes: a.notes ?? null,
        updated_at: new Date().toISOString(),
      }, { ingredients: "jsonb", instructions: "jsonb", tags: "text[]" });
      return ok(row);
    } catch (e) { return fail(e); }
  },
);

server.tool(
  "search_recipes",
  "Search recipes by name, cuisine, tags, or ingredient",
  {
    query: z.string().optional().describe("Search query for name"),
    cuisine: z.string().optional().describe("Filter by cuisine"),
    tag: z.string().optional().describe("Filter by tag"),
    ingredient: z.string().optional().describe("Search for recipes containing this ingredient"),
  },
  async (a) => {
    try {
      const cond = ["user_id = $1"];
      const params: unknown[] = [USER_ID];
      if (a.query) { params.push(`%${a.query}%`); cond.push(`name ILIKE $${params.length}`); }
      if (a.cuisine) { params.push(a.cuisine); cond.push(`cuisine = $${params.length}`); }
      if (a.tag) { params.push([a.tag]); cond.push(`tags @> $${params.length}::text[]`); }
      if (a.ingredient) {
        params.push(JSON.stringify([{ name: a.ingredient }]));
        cond.push(`ingredients @> $${params.length}::jsonb`);
      }
      const rows = await q(
        `SELECT * FROM recipes WHERE ${cond.join(" AND ")} ORDER BY created_at DESC`,
        params,
      );
      return ok(rows);
    } catch (e) { return fail(e); }
  },
);

server.tool(
  "update_recipe",
  "Update an existing recipe",
  {
    recipe_id: z.string().describe("Recipe ID (UUID)"),
    name: z.string().optional(),
    cuisine: z.string().optional(),
    prep_time_minutes: z.number().optional(),
    cook_time_minutes: z.number().optional(),
    servings: z.number().optional(),
    ingredients: z.array(z.object({ name: z.string(), quantity: z.string(), unit: z.string() })).optional(),
    instructions: z.array(z.string()).optional(),
    tags: z.array(z.string()).optional(),
    rating: z.number().optional(),
    notes: z.string().optional(),
  },
  async ({ recipe_id, ...fields }) => {
    try {
      const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
      const casts: Record<string, string> = {};
      for (const [k, v] of Object.entries(fields)) {
        if (v === undefined) continue;
        updates[k] = v;
        if (k === "ingredients" || k === "instructions") casts[k] = "jsonb";
        if (k === "tags") casts[k] = "text[]";
      }
      const row = await updateById("recipes", recipe_id, updates, { casts });
      return ok(row);
    } catch (e) { return fail(e); }
  },
);

server.tool(
  "create_meal_plan",
  "Plan meals for a week",
  {
    week_start: z.string().describe("Monday of the week (YYYY-MM-DD)"),
    meals: z.array(z.object({
      day_of_week: z.string(),
      meal_type: z.string(),
      recipe_id: z.string().optional(),
      custom_meal: z.string().optional(),
      servings: z.number().optional(),
      notes: z.string().optional(),
    })).describe("Array of meal entries"),
  },
  async (a) => {
    try {
      const out: Row[] = [];
      for (const m of a.meals) {
        out.push(await insertRow("meal_plans", {
          user_id: USER_ID,
          week_start: a.week_start,
          day_of_week: m.day_of_week,
          meal_type: m.meal_type,
          recipe_id: m.recipe_id ?? null,
          custom_meal: m.custom_meal ?? null,
          servings: m.servings ?? null,
          notes: m.notes ?? null,
        }));
      }
      return ok(out);
    } catch (e) { return fail(e); }
  },
);

server.tool(
  "get_meal_plan",
  "View the meal plan for a given week",
  { week_start: z.string().describe("Monday of the week (YYYY-MM-DD)") },
  async ({ week_start }) => {
    try {
      const rows = await q(
        `SELECT mp.*,
                CASE WHEN r.id IS NULL THEN NULL ELSE jsonb_build_object(
                  'name', r.name, 'cuisine', r.cuisine,
                  'prep_time_minutes', r.prep_time_minutes,
                  'cook_time_minutes', r.cook_time_minutes) END AS recipes
         FROM meal_plans mp
         LEFT JOIN recipes r ON r.id = mp.recipe_id
         WHERE mp.user_id = $1 AND mp.week_start = $2
         ORDER BY mp.day_of_week, mp.meal_type`,
        [USER_ID, week_start],
      );
      return ok(rows);
    } catch (e) { return fail(e); }
  },
);

server.tool(
  "generate_shopping_list",
  "Auto-generate a shopping list from a week's meal plan by aggregating recipe ingredients",
  { week_start: z.string().describe("Monday of the week (YYYY-MM-DD)") },
  async ({ week_start }) => {
    try {
      const meals = await q(
        `SELECT r.id AS recipe_id, r.ingredients AS ingredients
         FROM meal_plans mp
         JOIN recipes r ON r.id = mp.recipe_id
         WHERE mp.user_id = $1 AND mp.week_start = $2`,
        [USER_ID, week_start],
      );
      const itemsMap = new Map<string, Row>();
      for (const m of meals) {
        const ings = (m.ingredients ?? []) as Array<{ name: string; quantity: string; unit: string }>;
        for (const ing of ings) {
          const key = `${ing.name}-${ing.unit}`;
          if (itemsMap.has(key)) {
            itemsMap.get(key)!.quantity = `${itemsMap.get(key)!.quantity} + ${ing.quantity}`;
          } else {
            itemsMap.set(key, {
              name: ing.name, quantity: ing.quantity, unit: ing.unit,
              purchased: false, recipe_id: m.recipe_id,
            });
          }
        }
      }
      const items = Array.from(itemsMap.values());
      const existing = (await q(
        `SELECT id FROM shopping_lists WHERE user_id = $1 AND week_start = $2`,
        [USER_ID, week_start],
      ))[0];
      let result: Row;
      if (existing) {
        result = await updateById("shopping_lists", existing.id, {
          items, updated_at: new Date().toISOString(),
        }, { casts: { items: "jsonb" }, scopeUser: false });
      } else {
        result = await insertRow("shopping_lists", {
          user_id: USER_ID, week_start, items,
        }, { items: "jsonb" });
      }
      return ok(result);
    } catch (e) { return fail(e); }
  },
);

/* ===========================================================================
 * Extension 5: Professional CRM
 * ========================================================================= */

server.tool(
  "add_professional_contact",
  "Add a new professional contact to your network",
  {
    name: z.string().describe("Contact's full name"),
    company: z.string().optional(),
    title: z.string().optional(),
    email: z.string().optional(),
    phone: z.string().optional(),
    linkedin_url: z.string().optional(),
    how_we_met: z.string().optional(),
    tags: z.array(z.string()).optional().describe("Tags for categorization"),
    notes: z.string().optional(),
  },
  async (a) => {
    try {
      const contact = await insertRow("professional_contacts", {
        user_id: USER_ID,
        name: a.name,
        company: a.company ?? null,
        title: a.title ?? null,
        email: a.email ?? null,
        phone: a.phone ?? null,
        linkedin_url: a.linkedin_url ?? null,
        how_we_met: a.how_we_met ?? null,
        tags: a.tags ?? [],
        notes: a.notes ?? null,
      }, { tags: "text[]" });
      return ok({ success: true, message: `Added professional contact: ${a.name}`, contact });
    } catch (e) { return fail(e); }
  },
);

server.tool(
  "search_contacts",
  "Search professional contacts by name, company, or tags",
  {
    query: z.string().optional().describe("Search term (name, company, title, notes)"),
    tags: z.array(z.string()).optional().describe("Filter by specific tags"),
  },
  async ({ query, tags }) => {
    try {
      const cond = ["user_id = $1"];
      const params: unknown[] = [USER_ID];
      if (query) {
        params.push(`%${query}%`);
        const p = `$${params.length}`;
        cond.push(`(name ILIKE ${p} OR company ILIKE ${p} OR title ILIKE ${p} OR notes ILIKE ${p})`);
      }
      if (tags && tags.length > 0) { params.push(tags); cond.push(`tags @> $${params.length}::text[]`); }
      const contacts = await q(
        `SELECT * FROM professional_contacts WHERE ${cond.join(" AND ")} ORDER BY name ASC`,
        params,
      );
      return ok({ success: true, count: contacts.length, contacts });
    } catch (e) { return fail(e); }
  },
);

server.tool(
  "log_interaction",
  "Log an interaction with a contact (automatically updates last_contacted)",
  {
    contact_id: z.string().describe("Contact ID (UUID)"),
    interaction_type: z.enum(["meeting", "email", "call", "coffee", "event", "linkedin", "other"]),
    occurred_at: z.string().optional().describe("When it occurred (ISO 8601, defaults to now)"),
    summary: z.string().describe("Summary of the interaction"),
    follow_up_needed: z.boolean().optional(),
    follow_up_notes: z.string().optional(),
  },
  async (a) => {
    try {
      const interaction = await insertRow("contact_interactions", {
        user_id: USER_ID,
        contact_id: a.contact_id,
        interaction_type: a.interaction_type,
        occurred_at: a.occurred_at ?? new Date().toISOString(),
        summary: a.summary,
        follow_up_needed: a.follow_up_needed ?? false,
        follow_up_notes: a.follow_up_notes ?? null,
      });
      return ok({ success: true, message: "Interaction logged successfully", interaction });
    } catch (e) { return fail(e); }
  },
);

server.tool(
  "get_contact_history",
  "Get a contact's full profile and all interactions, ordered by date",
  { contact_id: z.string().describe("Contact ID (UUID)") },
  async ({ contact_id }) => {
    try {
      const contact = (await q(
        `SELECT * FROM professional_contacts WHERE id = $1 AND user_id = $2`,
        [contact_id, USER_ID],
      ))[0];
      if (!contact) throw new Error("Contact not found or access denied");
      const interactions = await q(
        `SELECT * FROM contact_interactions WHERE contact_id = $1 AND user_id = $2 ORDER BY occurred_at DESC`,
        [contact_id, USER_ID],
      );
      const opportunities = await q(
        `SELECT * FROM opportunities WHERE contact_id = $1 AND user_id = $2 ORDER BY created_at DESC`,
        [contact_id, USER_ID],
      );
      return ok({ success: true, contact, interactions, opportunities, interaction_count: interactions.length });
    } catch (e) { return fail(e); }
  },
);

server.tool(
  "create_opportunity",
  "Create a new opportunity/deal, optionally linked to a contact",
  {
    contact_id: z.string().optional().describe("Contact ID (UUID) - optional"),
    title: z.string().describe("Opportunity title"),
    description: z.string().optional(),
    stage: z.enum(["identified", "in_conversation", "proposal", "negotiation", "won", "lost"]).optional(),
    value: z.number().optional().describe("Estimated value in dollars"),
    expected_close_date: z.string().optional().describe("Expected close date (YYYY-MM-DD)"),
    notes: z.string().optional(),
  },
  async (a) => {
    try {
      const opportunity = await insertRow("opportunities", {
        user_id: USER_ID,
        contact_id: a.contact_id ?? null,
        title: a.title,
        description: a.description ?? null,
        stage: a.stage ?? "identified",
        value: a.value ?? null,
        expected_close_date: a.expected_close_date ?? null,
        notes: a.notes ?? null,
      });
      return ok({ success: true, message: `Created opportunity: ${a.title}`, opportunity });
    } catch (e) { return fail(e); }
  },
);

server.tool(
  "get_follow_ups_due",
  "List contacts with follow-ups due in the past or next N days",
  { days_ahead: z.number().optional().describe("Number of days to look ahead (default: 7)") },
  async ({ days_ahead = 7 }) => {
    try {
      const today = new Date().toISOString().split("T")[0];
      const data = await q(
        `SELECT * FROM professional_contacts
         WHERE user_id = $1 AND follow_up_date IS NOT NULL
           AND follow_up_date <= (CURRENT_DATE + ($2 || ' days')::interval)
         ORDER BY follow_up_date ASC`,
        [USER_ID, String(days_ahead)],
      );
      const overdue = data.filter((c) => String(c.follow_up_date) < today);
      const upcoming = data.filter((c) => String(c.follow_up_date) >= today);
      return ok({
        success: true,
        overdue_count: overdue.length,
        upcoming_count: upcoming.length,
        overdue, upcoming,
      });
    } catch (e) { return fail(e); }
  },
);

server.tool(
  "update_professional_contact",
  "Update an existing professional contact's details",
  {
    contact_id: z.string().describe("Contact ID (UUID)"),
    name: z.string().optional(),
    company: z.string().optional(),
    title: z.string().optional(),
    email: z.string().optional(),
    phone: z.string().optional(),
    linkedin_url: z.string().optional(),
    how_we_met: z.string().optional(),
    tags: z.array(z.string()).optional(),
    notes: z.string().optional(),
    follow_up_date: z.string().nullable().optional().describe("YYYY-MM-DD, or null/empty to clear"),
  },
  async ({ contact_id, ...fields }) => {
    try {
      const updates: Record<string, unknown> = {};
      const casts: Record<string, string> = {};
      for (const [k, v] of Object.entries(fields)) {
        if (k === "follow_up_date" && (v === null || v === "")) updates[k] = null;
        else if (v !== undefined) updates[k] = v;
        if (k === "tags" && v !== undefined) casts[k] = "text[]";
      }
      if (Object.keys(updates).length === 0) throw new Error("No fields provided to update");
      const contact = await updateById("professional_contacts", contact_id, updates, { casts });
      return ok({ success: true, message: `Updated contact: ${contact.name}`, contact });
    } catch (e) { return fail(e); }
  },
);

server.tool(
  "link_thought_to_contact",
  "CROSS-EXTENSION: Link a thought from your core Open Brain to a professional contact",
  {
    thought_id: z.string().describe("Thought ID from core Open Brain thoughts table"),
    contact_id: z.string().describe("Contact ID (UUID)"),
  },
  async ({ thought_id, contact_id }) => {
    try {
      const thought = (await q(`SELECT * FROM thoughts WHERE id = $1`, [thought_id]))[0];
      if (!thought) throw new Error("Thought not found or access denied");
      const contact = (await q(
        `SELECT * FROM professional_contacts WHERE id = $1 AND user_id = $2`,
        [contact_id, USER_ID],
      ))[0];
      if (!contact) throw new Error("Contact not found or access denied");
      const linkNote =
        `\n\n[Linked Thought ${new Date().toISOString().split("T")[0]}]: ${thought.content}`;
      const updatedContact = await updateById(
        "professional_contacts",
        contact_id,
        { notes: (contact.notes || "") + linkNote },
      );
      return ok({
        success: true,
        message: `Linked thought to contact: ${contact.name}`,
        thought_content: thought.content,
        contact: updatedContact,
      });
    } catch (e) { return fail(e); }
  },
);

/* ===========================================================================
 * Extension 6: Job Hunt Pipeline
 * ========================================================================= */

const COMPANY_JOIN =
  `CASE WHEN co.id IS NULL THEN NULL ELSE jsonb_build_object('id', co.id, 'name', co.name) END AS companies`;

server.tool(
  "add_company",
  "Add a company to track in your job search",
  {
    name: z.string().describe("Company name"),
    industry: z.string().optional(),
    website: z.string().optional(),
    size: z.enum(["startup", "mid-market", "enterprise"]).optional(),
    location: z.string().optional(),
    remote_policy: z.enum(["remote", "hybrid", "onsite"]).optional(),
    notes: z.string().optional(),
    glassdoor_rating: z.number().min(1.0).max(5.0).optional(),
  },
  async (a) => {
    try {
      const company = await insertRow("companies", {
        user_id: USER_ID,
        name: a.name,
        industry: a.industry ?? null,
        website: a.website ?? null,
        size: a.size ?? null,
        location: a.location ?? null,
        remote_policy: a.remote_policy ?? null,
        notes: a.notes ?? null,
        glassdoor_rating: a.glassdoor_rating ?? null,
      });
      return ok({ success: true, message: `Added company: ${a.name}`, company });
    } catch (e) { return fail(e); }
  },
);

server.tool(
  "add_job_posting",
  "Add a job posting at a company",
  {
    company_id: z.string().describe("Company ID (UUID)"),
    title: z.string().describe("Job title"),
    url: z.string().optional(),
    salary_min: z.number().optional(),
    salary_max: z.number().optional(),
    salary_currency: z.string().optional(),
    requirements: z.array(z.string()).optional(),
    nice_to_haves: z.array(z.string()).optional(),
    notes: z.string().optional(),
    source: z.enum(["linkedin", "company-site", "referral", "recruiter", "other"]).optional(),
    posted_date: z.string().optional(),
    closing_date: z.string().optional(),
  },
  async (a) => {
    try {
      const job_posting = await insertRow("job_postings", {
        user_id: USER_ID,
        company_id: a.company_id,
        title: a.title,
        url: a.url ?? null,
        salary_min: a.salary_min ?? null,
        salary_max: a.salary_max ?? null,
        salary_currency: a.salary_currency ?? "USD",
        requirements: a.requirements ?? [],
        nice_to_haves: a.nice_to_haves ?? [],
        notes: a.notes ?? null,
        source: a.source ?? null,
        posted_date: a.posted_date ?? null,
        closing_date: a.closing_date ?? null,
      }, { requirements: "text[]", nice_to_haves: "text[]" });
      return ok({ success: true, message: `Added job posting: ${a.title}`, job_posting });
    } catch (e) { return fail(e); }
  },
);

server.tool(
  "add_job_contact",
  "Add a recruiter, hiring manager, referral, or interviewer to your job search contacts",
  {
    company_id: z.string().optional(),
    name: z.string().describe("Contact's full name"),
    title: z.string().optional(),
    email: z.string().optional(),
    phone: z.string().optional(),
    linkedin_url: z.string().optional(),
    role_in_process: z.enum(["recruiter", "hiring_manager", "referral", "interviewer", "other"]).optional(),
    notes: z.string().optional(),
    last_contacted: z.string().optional(),
  },
  async (a) => {
    try {
      const inserted = await insertRow("job_contacts", {
        user_id: USER_ID,
        company_id: a.company_id ?? null,
        name: a.name,
        title: a.title ?? null,
        email: a.email ?? null,
        phone: a.phone ?? null,
        linkedin_url: a.linkedin_url ?? null,
        role_in_process: a.role_in_process ?? null,
        notes: a.notes ?? null,
        last_contacted: a.last_contacted ?? null,
      });
      const job_contact = (await q(
        `SELECT jc.*, ${COMPANY_JOIN}
         FROM job_contacts jc LEFT JOIN companies co ON co.id = jc.company_id
         WHERE jc.id = $1`,
        [inserted.id],
      ))[0];
      return ok({ success: true, message: `Added job contact: ${a.name}`, job_contact });
    } catch (e) { return fail(e); }
  },
);

server.tool(
  "submit_application",
  "Record a submitted application",
  {
    job_posting_id: z.string().describe("Job posting ID (UUID)"),
    status: z.enum(["draft", "applied", "screening", "interviewing", "offer", "accepted", "rejected", "withdrawn"]).optional(),
    applied_date: z.string().optional(),
    resume_version: z.string().optional(),
    cover_letter_notes: z.string().optional(),
    referral_contact: z.string().optional(),
    notes: z.string().optional(),
  },
  async (a) => {
    try {
      const application = await insertRow("applications", {
        user_id: USER_ID,
        job_posting_id: a.job_posting_id,
        status: a.status ?? "applied",
        applied_date: a.applied_date ?? null,
        resume_version: a.resume_version ?? null,
        cover_letter_notes: a.cover_letter_notes ?? null,
        referral_contact: a.referral_contact ?? null,
        notes: a.notes ?? null,
      });
      return ok({ success: true, message: "Application recorded successfully", application });
    } catch (e) { return fail(e); }
  },
);

server.tool(
  "schedule_interview",
  "Schedule an interview for an application",
  {
    application_id: z.string().describe("Application ID (UUID)"),
    interview_type: z.enum(["phone_screen", "technical", "behavioral", "system_design", "hiring_manager", "team", "final"]),
    scheduled_at: z.string().optional(),
    duration_minutes: z.number().optional(),
    interviewer_name: z.string().optional(),
    interviewer_title: z.string().optional(),
    notes: z.string().optional(),
  },
  async (a) => {
    try {
      const interview = await insertRow("interviews", {
        user_id: USER_ID,
        application_id: a.application_id,
        interview_type: a.interview_type,
        scheduled_at: a.scheduled_at ?? null,
        duration_minutes: a.duration_minutes ?? null,
        interviewer_name: a.interviewer_name ?? null,
        interviewer_title: a.interviewer_title ?? null,
        status: "scheduled",
        notes: a.notes ?? null,
      });
      return ok({ success: true, message: "Interview scheduled successfully", interview });
    } catch (e) { return fail(e); }
  },
);

server.tool(
  "log_interview_notes",
  "Add feedback/notes after an interview and mark it as completed",
  {
    interview_id: z.string().describe("Interview ID (UUID)"),
    feedback: z.string().optional(),
    rating: z.number().min(1).max(5).optional(),
  },
  async (a) => {
    try {
      const interview = await updateById("interviews", a.interview_id, {
        feedback: a.feedback ?? null,
        rating: a.rating ?? null,
        status: "completed",
      });
      return ok({ success: true, message: "Interview notes logged and status updated to completed", interview });
    } catch (e) { return fail(e); }
  },
);

const INTERVIEW_NESTED =
  `SELECT iv.*, (to_jsonb(ap) || jsonb_build_object(
      'job_postings', to_jsonb(jp) || jsonb_build_object('companies', to_jsonb(co))
   )) AS applications
   FROM interviews iv
   JOIN applications ap ON ap.id = iv.application_id
   JOIN job_postings jp ON jp.id = ap.job_posting_id
   JOIN companies co ON co.id = jp.company_id
   WHERE iv.user_id = $1 AND iv.status = 'scheduled'
     AND iv.scheduled_at >= now()
     AND iv.scheduled_at <= now() + ($2 || ' days')::interval
   ORDER BY iv.scheduled_at ASC`;

server.tool(
  "get_pipeline_overview",
  "Get a dashboard summary: application counts by status, upcoming interviews, recent activity",
  { days_ahead: z.number().optional().describe("Days to look ahead for interviews (default: 7)") },
  async ({ days_ahead = 7 }) => {
    try {
      const apps = await q(
        `SELECT status FROM applications WHERE user_id = $1`,
        [USER_ID],
      );
      const status_breakdown: Record<string, number> = {};
      for (const r of apps) status_breakdown[r.status] = (status_breakdown[r.status] || 0) + 1;
      const upcoming = await q(INTERVIEW_NESTED, [USER_ID, String(days_ahead)]);
      return ok({
        success: true,
        total_applications: apps.length,
        status_breakdown,
        upcoming_interviews_count: upcoming.length,
        upcoming_interviews: upcoming,
      });
    } catch (e) { return fail(e); }
  },
);

server.tool(
  "get_upcoming_interviews",
  "List interviews in the next N days with full company/role context",
  { days_ahead: z.number().optional().describe("Number of days to look ahead (default: 14)") },
  async ({ days_ahead = 14 }) => {
    try {
      const interviews = await q(INTERVIEW_NESTED, [USER_ID, String(days_ahead)]);
      return ok({ success: true, count: interviews.length, interviews });
    } catch (e) { return fail(e); }
  },
);

server.tool(
  "search_job_contacts",
  "Search or list job contacts so you can find the right recruiter/interviewer and their ID",
  {
    query: z.string().optional().describe("Search across name, title, email, notes, role, company name"),
    company_id: z.string().optional().describe("Filter to a specific company ID (UUID)"),
    role_in_process: z.enum(["recruiter", "hiring_manager", "referral", "interviewer", "other"]).optional(),
    only_unlinked: z.boolean().optional().describe("Only contacts not yet linked to Professional CRM"),
  },
  async (a) => {
    try {
      const cond = ["jc.user_id = $1"];
      const params: unknown[] = [USER_ID];
      const term = a.query?.trim();
      if (term) {
        params.push(`%${term}%`);
        const p = `$${params.length}`;
        cond.push(
          `(jc.name ILIKE ${p} OR jc.title ILIKE ${p} OR jc.email ILIKE ${p} OR jc.notes ILIKE ${p} OR jc.role_in_process ILIKE ${p} OR co.name ILIKE ${p})`,
        );
      }
      if (a.company_id) { params.push(a.company_id); cond.push(`jc.company_id = $${params.length}`); }
      if (a.role_in_process) { params.push(a.role_in_process); cond.push(`jc.role_in_process = $${params.length}`); }
      if (a.only_unlinked) cond.push(`jc.professional_crm_contact_id IS NULL`);
      const contacts = await q(
        `SELECT jc.*, ${COMPANY_JOIN}
         FROM job_contacts jc LEFT JOIN companies co ON co.id = jc.company_id
         WHERE ${cond.join(" AND ")}
         ORDER BY jc.created_at DESC`,
        params,
      );
      return ok({ success: true, count: contacts.length, contacts });
    } catch (e) { return fail(e); }
  },
);

server.tool(
  "link_contact_to_professional_crm",
  "CROSS-EXTENSION: Link a job contact to Extension 5 Professional CRM, creating a professional_contacts record",
  { job_contact_id: z.string().describe("Job contact ID (UUID)") },
  async ({ job_contact_id }) => {
    try {
      const jc = (await q(
        `SELECT * FROM job_contacts WHERE id = $1 AND user_id = $2`,
        [job_contact_id, USER_ID],
      ))[0];
      if (!jc) throw new Error("Job contact not found or access denied");
      if (jc.professional_crm_contact_id) {
        return ok({
          success: true,
          message: "Contact already linked to Professional CRM",
          job_contact: jc,
          already_linked: true,
        });
      }
      let companyName: string | null = null;
      if (jc.company_id) {
        const co = (await q(`SELECT name FROM companies WHERE id = $1`, [jc.company_id]))[0];
        companyName = co?.name ?? null;
      }
      const professional_contact = await insertRow("professional_contacts", {
        user_id: USER_ID,
        name: jc.name,
        company: companyName,
        title: jc.title,
        email: jc.email,
        phone: jc.phone,
        linkedin_url: jc.linkedin_url,
        how_we_met: `Job search - ${jc.role_in_process || "contact"}`,
        tags: ["job-hunt", jc.role_in_process || "contact"],
        notes: jc.notes,
        last_contacted: jc.last_contacted,
      }, { tags: "text[]" });
      const job_contact = await updateById("job_contacts", job_contact_id, {
        professional_crm_contact_id: professional_contact.id,
      });
      return ok({
        success: true,
        message: `Linked ${jc.name} to Professional CRM`,
        job_contact,
        professional_contact,
      });
    } catch (e) { return fail(e); }
  },
);

/* ===========================================================================
 * Extension 7: Compiled Wiki (read-only) — req 13
 *
 * Reads the markdown + graph.json the openbrain-wiki compiler writes to
 * the shared volume (WIKI_DIR). Slug = filename without `.md`. No DB.
 * ========================================================================= */

// Minimal YAML-frontmatter reader for the keys generate-wiki.mjs emits
// (scalars + JSON-array values like derived_from_ids/source_doc_ids).
function parseFrontmatter(md: string): { fm: Record<string, unknown>; body: string } {
  const m = md.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { fm: {}, body: md };
  const fm: Record<string, unknown> = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    let raw = kv[2].trim();
    let val: unknown = raw;
    if ((raw.startsWith("[") && raw.endsWith("]")) ||
        (raw.startsWith('"') && raw.endsWith('"'))) {
      try { val = JSON.parse(raw); } catch { val = raw; }
    } else if (/^-?\d+$/.test(raw)) {
      val = Number(raw);
    }
    fm[key] = val;
  }
  return { fm, body: m[2] };
}

// Recurse: the wiki is now organized into type/topic subfolders
// (content/<type>/<slug>.md, content/topic/<slug>.md, index.md). Paths
// are returned relative to WIKI_DIR.
async function listWikiFiles(dir: string = WIKI_DIR, rel = ""): Promise<string[]> {
  const out: string[] = [];
  try {
    for await (const e of Deno.readDir(dir)) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory) {
        out.push(...(await listWikiFiles(`${dir}/${e.name}`, r)));
      } else if (e.isFile && e.name.endsWith(".md")) {
        out.push(r);
      }
    }
  } catch (_e) { /* dir not created yet → empty wiki */ }
  return out.sort();
}

// Slug = basename without .md (folder-independent). Wikilinks/backlinks
// resolve by basename, so subfoldering doesn't change slug semantics.
function slugOf(file: string): string {
  return file.split("/").pop()!.replace(/\.md$/, "");
}

async function readGraph(): Promise<{
  nodes: Array<Record<string, unknown>>;
  edges: Array<Record<string, unknown>>;
}> {
  try {
    const txt = await Deno.readTextFile(`${WIKI_DIR}/graph.json`);
    const g = JSON.parse(txt);
    return { nodes: g.nodes ?? [], edges: g.edges ?? [] };
  } catch (_e) {
    return { nodes: [], edges: [] };
  }
}

server.tool(
  "wiki_list_pages",
  "List compiled wiki pages (slug, title, entity type/name, generation metadata). Optionally filter by entity type.",
  {
    entity_type: z.string().optional().describe("Filter by entity_type (e.g. 'person', 'tool', 'project')"),
    limit: z.number().optional().describe("Max pages to return (default 200)"),
  },
  async ({ entity_type, limit }) => {
    try {
      const files = await listWikiFiles();
      const pages: Array<Record<string, unknown>> = [];
      for (const f of files) {
        const { fm } = parseFrontmatter(await Deno.readTextFile(`${WIKI_DIR}/${f}`));
        if (entity_type && fm.entity_type !== entity_type) continue;
        pages.push({
          slug: slugOf(f),
          title: fm.title ?? slugOf(f),
          entity_name: fm.entity_name ?? null,
          entity_type: fm.entity_type ?? null,
          generated_at: fm.generated_at ?? null,
          linked_thought_count: fm.linked_thought_count ?? 0,
          source_doc_count: fm.source_doc_count ?? 0,
        });
        if (pages.length >= (limit ?? 200)) break;
      }
      return ok({ success: true, count: pages.length, pages });
    } catch (e) { return fail(e); }
  },
);

server.tool(
  "wiki_read_page",
  "Read one compiled wiki page by slug. Returns markdown body + parsed frontmatter (incl. provenance: derived_from_ids thoughts, source_doc_ids sources).",
  { slug: z.string().describe("Page slug (filename without .md, e.g. 'tool-postgresql')") },
  async ({ slug }) => {
    try {
      const safe = slug.replace(/[^A-Za-z0-9_-]/g, "");
      // Resolve by basename across the type/topic subfolders.
      const files = await listWikiFiles();
      const match = files.find((f) => slugOf(f) === safe);
      if (!match) throw new Error(`No wiki page for slug '${safe}'`);
      const md = await Deno.readTextFile(`${WIKI_DIR}/${match}`);
      const { fm, body } = parseFrontmatter(md);
      return ok({ success: true, slug: safe, path: match, frontmatter: fm, markdown: body });
    } catch (e) { return fail(e); }
  },
);

server.tool(
  "wiki_search",
  "Full-text search across compiled wiki pages. Returns matching pages with a snippet around the first hit.",
  {
    query: z.string().describe("Case-insensitive search term"),
    limit: z.number().optional().describe("Max matching pages (default 15)"),
  },
  async ({ query, limit }) => {
    try {
      const needle = query.toLowerCase();
      const files = await listWikiFiles();
      const hits: Array<Record<string, unknown>> = [];
      for (const f of files) {
        const md = await Deno.readTextFile(`${WIKI_DIR}/${f}`);
        const idx = md.toLowerCase().indexOf(needle);
        if (idx === -1) continue;
        const { fm } = parseFrontmatter(md);
        const start = Math.max(0, idx - 120);
        hits.push({
          slug: slugOf(f),
          title: fm.title ?? slugOf(f),
          entity_type: fm.entity_type ?? null,
          snippet: md.slice(start, idx + 160).replace(/\s+/g, " ").trim(),
        });
        if (hits.length >= (limit ?? 15)) break;
      }
      return ok({ success: true, count: hits.length, results: hits });
    } catch (e) { return fail(e); }
  },
);

server.tool(
  "wiki_get_backlinks",
  "Find compiled pages that link TO the given slug via Obsidian [[wikilinks]] (true backlinks, as the viewer resolves them).",
  { slug: z.string().describe("Target page slug (filename without .md)") },
  async ({ slug }) => {
    try {
      const safe = slug.replace(/[^A-Za-z0-9_-]/g, "");
      // Match [[safe]] or [[safe|alias]] — the slug must be the link target.
      const re = new RegExp(`\\[\\[${safe}(\\||\\]\\])`);
      const files = await listWikiFiles();
      const backlinks: Array<Record<string, unknown>> = [];
      for (const f of files) {
        if (slugOf(f) === safe) continue;
        const md = await Deno.readTextFile(`${WIKI_DIR}/${f}`);
        if (re.test(md)) {
          const { fm } = parseFrontmatter(md);
          backlinks.push({ slug: slugOf(f), title: fm.title ?? slugOf(f), entity_type: fm.entity_type ?? null });
        }
      }
      return ok({ success: true, target: safe, count: backlinks.length, backlinks });
    } catch (e) { return fail(e); }
  },
);

server.tool(
  "wiki_get_related",
  "Get entities related to the given page slug from the typed graph (graph.json): neighbors with relation type, direction, and weight.",
  {
    slug: z.string().describe("Page slug (filename without .md)"),
    limit: z.number().optional().describe("Max related entities (default 50)"),
  },
  async ({ slug, limit }) => {
    try {
      const safe = slug.replace(/[^A-Za-z0-9_-]/g, "");
      const { nodes, edges } = await readGraph();
      const self = nodes.find((n) => n.slug === safe);
      if (!self) throw new Error(`No graph node for slug '${safe}' (is graph.json built?)`);
      const byId = new Map(nodes.map((n) => [n.id, n]));
      const related: Array<Record<string, unknown>> = [];
      for (const e of edges) {
        let other: unknown = null;
        let dir = "";
        if (e.source === self.id) { other = byId.get(e.target); dir = "out"; }
        else if (e.target === self.id) { other = byId.get(e.source); dir = "in"; }
        else continue;
        if (!other) continue;
        const o = other as Record<string, unknown>;
        related.push({
          slug: o.slug, label: o.label, type: o.type,
          relation: e.relation, direction: dir, weight: e.weight ?? 1,
        });
        if (related.length >= (limit ?? 50)) break;
      }
      return ok({ success: true, slug: safe, count: related.length, related });
    } catch (e) { return fail(e); }
  },
);

server.tool(
  "wiki_trigger_recompile",
  "Trigger an on-demand wiki recompile (the scheduled compile still runs independently). Returns the compiler service's response.",
  {},
  async () => {
    try {
      if (!WIKI_RECOMPILE_URL) {
        throw new Error("WIKI_RECOMPILE_URL not configured; recompile runs on schedule only.");
      }
      const r = await fetch(WIKI_RECOMPILE_URL, {
        method: "POST",
        headers: { "x-brain-key": MCP_ACCESS_KEY, "content-type": "application/json" },
      });
      const text = await r.text();
      let parsed: unknown = text;
      try { parsed = JSON.parse(text); } catch { /* keep text */ }
      if (!r.ok) throw new Error(`recompile trigger failed (${r.status}): ${text.slice(0, 300)}`);
      return ok({ success: true, triggered: true, response: parsed });
    } catch (e) { return fail(e); }
  },
);

/* ===========================================================================
 * HTTP transport (auth + CORS), same shape as the core server.
 * ========================================================================= */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-brain-key, x-access-key, accept, mcp-session-id, mcp-protocol-version, last-event-id",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS, DELETE",
};

const app = new Hono();

app.options("*", (c) => c.text("ok", 200, corsHeaders));

app.all("*", async (c) => {
  const provided = c.req.header("x-brain-key") ||
    c.req.header("x-access-key") ||
    new URL(c.req.url).searchParams.get("key");
  if (!provided || provided !== MCP_ACCESS_KEY) {
    return c.json({ error: "Invalid or missing access key" }, 401, corsHeaders);
  }

  if (!c.req.header("accept")?.includes("text/event-stream")) {
    const headers = new Headers(c.req.raw.headers);
    headers.set("Accept", "application/json, text/event-stream");
    const patched = new Request(c.req.raw.url, {
      method: c.req.raw.method,
      headers,
      body: c.req.raw.body,
      // @ts-ignore -- duplex required for streaming body in Deno
      duplex: "half",
    });
    Object.defineProperty(c.req, "raw", { value: patched, writable: true });
  }

  const transport = new StreamableHTTPTransport();
  await server.connect(transport);
  return transport.handleRequest(c);
});

Deno.serve({ port: parseInt(Deno.env.get("PORT") || "8000", 10) }, app.fetch);
