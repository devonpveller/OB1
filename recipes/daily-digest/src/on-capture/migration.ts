/**
 * The migration investigation (research-workbench P7a, D6): which captured ON episodes can be
 * re-rendered through the NEW pipeline, decided by ONE written test.
 *
 * THE CLEAN-MIGRATION TEST: an episode migrates only if its inputs are expressible in the new
 * contract's types with no compatibility path or field in the renderer - i.e. a RoomTranscript
 * (title + turns of {presenterId, text}) and a Team from the presenter model. Concretely: ON's
 * transcript exists, every turn has a speaker and dialogue, and every speaker name is a presenter
 * of the team mapped from the episode's own speaker_profile. Then the synthetic room transcript is
 * ON's transcript as content with the migrated profile as presenters, and the renderer voices it
 * like any other. Anything else is ARCHIVED ONLY (its original audio, if ON made any, plays from the
 * archive). ON's outline and transcript generator is never migrated (design-only, D9).
 *
 * The renderer never sees this module: the conversion happens here, outside it.
 */
import type { RoomTranscript, Team } from "../podcast/presenters.ts";
import type { OnRecord } from "./on-mapping.ts";

export type Outcome = "migrates" | "archived";

export interface Classified {
  onId: string;
  name: string;
  cls: string; // the episode class
  outcome: Outcome;
  reason: string;
  transcript?: RoomTranscript;
}

export const CLEAN_MIGRATION_TEST =
  "An ON episode migrates only if its inputs are expressible in the new contract's types with no " +
  "compatibility path or field in the renderer: ON's transcript exists, every turn has a speaker and " +
  "dialogue, and every speaker is a presenter (by name) of the team mapped from the episode's own " +
  "speaker_profile - then the synthetic room transcript is RoomTranscript{title: ON name, turns: " +
  "[{presenterId: that presenter, text: dialogue}]} with the migrated team as presenters. Otherwise it " +
  "is archived only.";

export function classify(ep: OnRecord, teams: Team[], teamIdOf: Record<string, string>): Classified {
  const onId = String(ep.id);
  const name = String(ep.name ?? "");
  const sp = (ep.speaker_profile ?? {}) as OnRecord;
  const turns = ((ep.transcript as OnRecord | null)?.transcript ?? null) as OnRecord[] | null;
  const status = String(ep.job_status ?? ep.status ?? "");
  if (!turns || !turns.length) {
    return {
      onId, name, cls: `no-transcript (${status || "no status"})`, outcome: "archived",
      reason: `ON produced no transcript${ep.audio_file ? "" : " and no audio"} for this episode` +
        `${ep.error_message ? ` (ON error: ${String(ep.error_message).slice(0, 120)})` : ""}: there is nothing in ON's output to express as turns`,
    };
  }
  const team = teams.find((t) => t.id === teamIdOf[String(sp.id)]);
  if (!team) {
    return { onId, name, cls: "speaker-profile-not-captured", outcome: "archived", reason: `its speaker_profile ${sp.id} is not one of ON's captured profiles` };
  }
  const byName = new Map(team.presenters.map((p) => [p.name, p.id]));
  const unknown = new Set<string>();
  for (const t of turns) if (!byName.has(String(t.speaker ?? ""))) unknown.add(String(t.speaker ?? "(none)"));
  if (unknown.size) {
    return {
      onId, name, cls: "speaker-not-in-team", outcome: "archived",
      reason: `speaker(s) ${[...unknown].join(", ")} are not presenters of team "${team.name}": voicing them would need a compatibility mapping`,
    };
  }
  const empty = turns.filter((t) => !String(t.dialogue ?? "").trim()).length;
  if (empty === turns.length) return { onId, name, cls: "empty-dialogue", outcome: "archived", reason: "every turn's dialogue is empty" };
  return {
    onId, name, cls: `transcript-speakers-in-team (${team.name})`, outcome: "migrates",
    reason: `all ${turns.length} turns' speakers are presenters of "${team.name}"; the transcript is a RoomTranscript as it stands`,
    transcript: {
      title: name,
      turns: turns.filter((t) => String(t.dialogue ?? "").trim()).map((t) => ({ presenterId: byName.get(String(t.speaker))!, text: String(t.dialogue).trim() })),
    },
  };
}

/** One recorded outcome per episode class, with its reason and count. */
export function byClass(all: Classified[]) {
  const m = new Map<string, { cls: string; outcome: Outcome; reason: string; count: number; examples: string[] }>();
  for (const c of all) {
    const k = `${c.cls}|${c.outcome}`;
    const e = m.get(k) ?? { cls: c.cls, outcome: c.outcome, reason: c.reason, count: 0, examples: [] };
    e.count++;
    if (e.examples.length < 3) e.examples.push(c.onId);
    m.set(k, e);
  }
  return [...m.values()];
}
