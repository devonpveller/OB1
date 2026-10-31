/**
 * The presenter model (research-workbench P7a). What a podcast is voiced BY:
 *
 *   VoiceLink  - how one presenter sounds: a LiteLLM route (the gateway model name, e.g.
 *                `local-tts`), a voice of that route and a speed. The operator links a presenter
 *                to a voice; changing the link re-voices only that presenter's turns (the segment
 *                cache keys on it).
 *   Presenter  - a named voice with a personality and a backstory (both go into the script
 *                prompt so two presenters also READ differently).
 *   Team       - an ordered cast. Position 0 speaks the script's "HOST A" lines, 1 "HOST B", ...
 *   Format     - how an episode of a team is shaped: briefing, segment count, language and the
 *                LiteLLM route that writes the script.
 *
 * This module is the renderer's whole vocabulary. It knows nothing of where a team came from: a
 * team captured from another system and one the operator configured are the same type.
 */

export interface VoiceLink {
  id: string;
  route: string; // a LiteLLM model name (the gateway route), never a backend URL
  voice: string;
  speed: number;
}

export interface Presenter {
  id: string;
  name: string;
  personality: string;
  backstory: string;
  language: string;
  voice: VoiceLink;
}

export interface Team {
  id: string;
  name: string;
  description: string;
  presenters: Presenter[]; // ordered: index = speaking position
}

export interface Format {
  id: string;
  name: string;
  description: string;
  teamId: string;
  briefing: string;
  segments: number;
  language: string;
  scriptRoute: string; // a LiteLLM model name
}

/** One spoken turn: who speaks (a presenter id of the team) and what. */
export interface Turn {
  presenterId: string;
  text: string;
}

/** What the renderer voices: a title and its turns. A room transcript, a daily script, a migrated
 *  transcript - all arrive as this. */
export interface RoomTranscript {
  title: string;
  turns: Turn[];
}

/** "HOST A" -> 0, "HOST B" -> 1, ... */
export function hostIndex(label: string): number {
  const m = /^HOST\s+([A-Z])$/i.exec(label.trim());
  return m ? m[1].toUpperCase().charCodeAt(0) - 65 : -1;
}

export function hostLabel(i: number): string {
  return `HOST ${String.fromCharCode(65 + i)}`;
}

/**
 * The script's speaker lines (`HOST A: ...`) as turns of the team. A line without a label
 * continues the previous turn; a label beyond the cast, or text before the first label, is an
 * error (the script and the cast disagree - rendering it would put words in the wrong mouth).
 */
export function turnsFromHostScript(title: string, script: string, team: Team): RoomTranscript {
  const turns: Turn[] = [];
  for (const raw of script.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^\**\s*(HOST\s+[A-Z])\s*\**\s*:\s*(.*)$/i.exec(line);
    if (m) {
      const i = hostIndex(m[1]);
      const p = team.presenters[i];
      if (!p) throw new Error(`the script has ${m[1].toUpperCase()} but team "${team.name}" has ${team.presenters.length} presenter(s)`);
      if (m[2].trim()) turns.push({ presenterId: p.id, text: m[2].trim() });
      else turns.push({ presenterId: p.id, text: "" });
      continue;
    }
    const last = turns.at(-1);
    if (!last) throw new Error("the script has text before its first HOST label");
    last.text = last.text ? `${last.text} ${line}` : line;
  }
  const spoken = turns.filter((t) => t.text);
  if (!spoken.length) throw new Error("the script has no spoken turns");
  return { title, turns: spoken };
}

/** The cast block the script prompt carries: who each HOST label is and how they talk. */
export function castBlock(team: Team): string {
  const lines = team.presenters.map((p, i) =>
    `${hostLabel(i)} is ${p.name}.${p.backstory ? ` Background: ${p.backstory}` : ""}${p.personality ? ` Personality: ${p.personality}` : ""}`
  );
  return `THE CAST (write each host in their own voice; keep the "HOST A:" style labels):\n${lines.join("\n")}`;
}

export function presenterOf(team: Team, id: string): Presenter {
  const p = team.presenters.find((x) => x.id === id);
  if (!p) throw new Error(`presenter ${id} is not in team "${team.name}"`);
  return p;
}
