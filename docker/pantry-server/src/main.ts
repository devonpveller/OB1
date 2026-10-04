import { createApp } from "./app.ts";
import { makeDb } from "./db.ts";

const USER_ID = Deno.env.get("DEFAULT_USER_ID") ?? "";
const API_KEY = Deno.env.get("PANTRY_API_KEY") ?? "";

if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(USER_ID)) {
  console.error("DEFAULT_USER_ID is not a valid UUID");
  Deno.exit(1);
}
if (!API_KEY) {
  console.error("PANTRY_API_KEY is empty; refusing to start an unauthenticated pantry");
  Deno.exit(1);
}
const dbUser = Deno.env.get("DB_USER") ?? "ob_pantry";
if (dbUser === "postgres") {
  console.error("DB_USER must be the least-privilege ob_pantry role, not postgres");
  Deno.exit(1);
}

const db = makeDb({
  hostname: Deno.env.get("DB_HOST") ?? "openbrain-db",
  port: parseInt(Deno.env.get("DB_PORT") ?? "5432", 10),
  database: Deno.env.get("DB_NAME") ?? "openbrain",
  user: dbUser,
  password: Deno.env.get("DB_PASSWORD") ?? "",
}, parseInt(Deno.env.get("DB_POOL") ?? "8", 10));

// Fail closed: never run as a superuser or a role that can bypass row security.
{
  const r = await db.q<{ rolsuper: boolean; rolbypassrls: boolean; u: string }>(
    "SELECT rolsuper, rolbypassrls, current_user AS u FROM pg_roles WHERE rolname = current_user",
  );
  if (!r[0] || r[0].rolsuper || r[0].rolbypassrls) {
    console.error(`connected as ${r[0]?.u}: superuser/BYPASSRLS is not allowed for the pantry service`);
    Deno.exit(1);
  }
}

const app = createApp({ db, userId: USER_ID, apiKey: API_KEY });
const port = parseInt(Deno.env.get("PORT") ?? "8000", 10);
Deno.serve({ port, hostname: "0.0.0.0" }, app.fetch);
console.log(`openbrain-pantry listening on :${port}`);
