// deno-postgres surfaces the SQLSTATE on the thrown error's `.fields.code`.
// 23505 = unique_violation (used for slug de-collision).
export function isUniqueViolation(err: unknown): boolean {
  // deno-postgres PostgresError shape.
  const code = (err as { fields?: { code?: string } } | undefined)?.fields?.code;
  return code === "23505";
}
