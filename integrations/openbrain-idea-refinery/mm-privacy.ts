// mm-privacy.ts - may the refinery write into this Mattermost channel? (research-workbench rw-idea-privacy, operator
// 2026-11-02: "ideas are completely user isolated"). Pure: index.ts fetches the channel and its members.
//
// The brainstorm loop reads idea threads and answers them (and posts gap research) in IDEA_REFINERY_CHANNEL. It may do
// that only where no second human can read: a private ('P') or direct ('D') channel with at most ONE human member
// (bots - this service among them - are not readers). A public ('O') channel - #ideas was created that way, readable by
// every member of the bot's team - or a group / private channel with a second human is refused. The refinery never
// creates a channel any more.

export interface MmMember { user_id: string; is_bot: boolean }

/** "" = allowed; otherwise why the channel is refused (no names, no ids). */
export function channelRefusal(type: string, members: MmMember[]): string {
  if (type !== "P" && type !== "D") return `is not private (type ${type || "unknown"})`;
  const humans = new Set(members.filter((m) => !m.is_bot).map((m) => m.user_id));
  if (humans.size > 1) return `has ${humans.size} human members (a second person could read it)`;
  return "";
}
