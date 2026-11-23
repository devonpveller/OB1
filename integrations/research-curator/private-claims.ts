// rw-private-report-claims-fix round 2 (tester attempt 1, P2): a shared thread is never NAMED or DESCRIBED from a
// report that restates a private-report claim. The curator mints a new thread's description from the report (the
// resolver's description or the report's headline) and refreshThread rewrites an existing one from every synthesis
// filed into it; threads are shared (the MCP thread list, the wiki hub, podcasts). The database decides
// (public.private_report_claims_text_shows, slot 570: the skeleton match, every private-report claim - this is machine
// text, the curator's own package, never a person's input). Fail closed: any error but "the function is absent"
// (42883: slot 570 not applied, or reverted - nothing is private-report then) counts as restating.

export type QueryBool = (sql: string, args: unknown[]) => Promise<Array<{ shows: boolean | null }>>;

export async function restatesPrivateClaim(q: QueryBool, text: string): Promise<boolean> {
  if (!text || !text.trim()) return false;
  try {
    const rows = await q(`SELECT public.private_report_claims_text_shows($1) AS shows`, [text]);
    return rows[0]?.shows === true;
  } catch (e) {
    const code = (e as { fields?: { code?: string } }).fields?.code;
    if (code === "42883") return false;
    return true;
  }
}

/** The name and description a NEW thread gets: as resolved, unless the report restates a private-report claim - then
 *  no description, and a neutral name when the name itself carries it. */
export async function threadTextFor(
  q: QueryBool, name: string, description: string, report: string,
): Promise<{ name: string; description: string }> {
  if (!(await restatesPrivateClaim(q, `${name}\n${description}\n${report}`))) return { name, description };
  return { name: (await restatesPrivateClaim(q, name)) ? "Research thread" : name, description: "" };
}
