// mm-privacy.ts - may the refinery write into this Mattermost channel? (research-workbench rw-idea-privacy, operator
// 2026-11-02: "ideas are completely user isolated"). Pure: index.ts fetches the channel and its members.
//
// The brainstorm loop reads idea threads and answers them (and posts gap research) in IDEA_REFINERY_CHANNEL. It may do
// that only where no second human can read: a private ('P') or direct ('D') channel with at most ONE human member
// (bots - this service among them - are not readers), and that one human must be an authorised reader: one of
// IDEA_BRAINSTORM_OPERATORS, the people a brainstorm answers. A public ('O') channel - #ideas was created that way,
// readable by every member of the bot's team - a group / private channel with a second human, or one whose human is not
// an authorised reader, is refused. The refinery never creates a channel any more.
// THE LIMIT: no idea owner -> Mattermost user mapping exists (rw-idea-privacy findings), so "the one human is the IDEA'S
// OWNER" cannot be checked here; "the one human is an authorised operator" is the check that can be made.

export interface MmMember { user_id: string; username: string; is_bot: boolean }

/** "" = allowed; otherwise why the channel is refused (no names, no ids). */
export function channelRefusal(type: string, members: MmMember[], readers: Set<string>): string {
  if (type !== "P" && type !== "D") return `is not private (type ${type || "unknown"})`;
  const humans = members.filter((m) => !m.is_bot);
  const ids = new Set(humans.map((m) => m.user_id));
  if (ids.size > 1) return `has ${ids.size} human members (a second person could read it)`;
  if (humans.length && !readers.has(humans[0].username.toLowerCase())) return "has a human member who is not an authorised reader (IDEA_BRAINSTORM_OPERATORS)";
  return "";
}
