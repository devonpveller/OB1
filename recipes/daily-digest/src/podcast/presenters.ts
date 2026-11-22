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
  // rwr-cast-edit-api (slot 560): how the presenter reads. Optional and "" when not set - then the cast block is exactly
  // what it was before them (the golden-script test, cast-fields.test.ts). No model route: phase J (operator-gated).
  role?: string;
  focus?: string;
  stance?: string;
  tone?: string;
  speakingStyle?: string;
  systemPrompt?: string;
  systemPromptMode?: string; // "built" (default: the line is built from the fields) | "own" (systemPrompt is the line)
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

// A field the owner typed goes into the prompt on ONE line: line breaks and runs of spaces collapse, so it can never
// start a line of its own (a fake "HOST B:" label, a new instruction block). Only the rwr-cast-edit-api fields pass
// through it; the fields before them are written exactly as they always were (byte-identical output when none is set).
const oneLine = (s: string | undefined) => (s ?? "").replace(/\s+/g, " ").trim();

/** The rwr-cast-edit-api fields of a presenter, in a fixed order, each only where set. "" when none is. */
export function castFields(p: Presenter): string {
  const parts: [string, string | undefined][] = [
    ["Role", p.role], ["Focus", p.focus], ["Stance", p.stance], ["Tone", p.tone], ["Speaking style", p.speakingStyle],
  ];
  return parts.map(([k, v]) => [k, oneLine(v)]).filter(([, v]) => v).map(([k, v]) => ` ${k}: ${v}`).join("");
}

/** The cast block the script prompt carries: who each HOST label is and how they talk. A presenter whose system prompt
 *  is its owner's own ("own", with text) is described by that text; otherwise the line is built from the fields, the
 *  rwr-cast-edit-api ones appended only where set (a presenter with none set reads exactly as before). */
export function castBlock(team: Team): string {
  const lines = team.presenters.map((p, i) => {
    const own = p.systemPromptMode === "own" ? oneLine(p.systemPrompt) : "";
    if (own) return `${hostLabel(i)} is ${p.name}. ${own}`;
    return `${hostLabel(i)} is ${p.name}.${p.backstory ? ` Background: ${p.backstory}` : ""}${p.personality ? ` Personality: ${p.personality}` : ""}${castFields(p)}`;
  });
  return `THE CAST (write each host in their own voice; keep the "HOST A:" style labels):\n${lines.join("\n")}`;
}

export function presenterOf(team: Team, id: string): Presenter {
  const p = team.presenters.find((x) => x.id === id);
  if (!p) throw new Error(`presenter ${id} is not in team "${team.name}"`);
  return p;
}
