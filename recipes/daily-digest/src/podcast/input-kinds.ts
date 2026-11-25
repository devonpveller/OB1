/**
 * The render request's input kinds (research-workbench-redesign rwr-episode-from).
 *
 * A render request's `input` is one of:
 *   { transcript: RoomTranscript }                         the original kind: a room transcript (kind "transcript")
 *   { source: { kind, id, title, text, items } }           material the WORKBENCH resolved on the requester's own side
 *                                                          (a research run, a report, a document, an idea, a topic,
 *                                                          later a discussion) - owner-checked there, by the identity
 *                                                          seam's subject, before this row was written
 *
 * THE EXPANSION RULE: this registry is the ONLY place a kind is named. render-service.ts looks the kind up
 * and calls its `toTranscript`; it has no switch and no per-kind test (input-kinds.test.ts reads its source to
 * prove it, and renders a kind registered in the test alone). A new kind = one `register` call here (and its
 * resolver in the workbench, docker/workbench/src/contracts/logic/episode_inputs.ts).
 *
 * `personal` = the material starts from the requester's personal data. The renderer treats it as private all the
 * way: its title and text appear in no log line, a failure records a class rather than text, and the episode is
 * never shared by anything in this service (the share step is the workbench's, after a disclosure).
 *
 * THE SCRIPT WRITER is the service's gateway chat (LiteLLM alias, the podcast service's existing virtual key);
 * nothing here opens another route to a model.
 */
import { castBlock, type RoomTranscript, type Team, turnsFromHostScript } from "./presenters.ts";
import type { ChatFn } from "./script-renderer.ts";

/** What a kind turns into a transcript: the resolved material (or the legacy transcript). */
export interface InputMaterial {
  kind: string;
  id: string;
  title: string;
  text: string;
  items: unknown[];
  transcript?: RoomTranscript;
}

export interface InputContext {
  team: Team;
  chat: ChatFn;
}

export interface InputKind {
  id: string;
  label: string;
  /** starts from personal data: private end to end (no title or text in a log, no text in an error) */
  personal: boolean;
  /** false = registered but not usable yet (discussion: waits for its store) */
  available: boolean;
  toTranscript(input: InputMaterial, ctx: InputContext): Promise<RoomTranscript>;
}

export class InputKindRegistry {
  readonly #kinds = new Map<string, InputKind>();
  register(k: InputKind): this {
    if (this.#kinds.has(k.id)) throw new Error(`input kind ${k.id} is already registered`);
    this.#kinds.set(k.id, k);
    return this;
  }
  get(id: string): InputKind | undefined {
    return this.#kinds.get(id);
  }
  ids(): string[] {
    return [...this.#kinds.keys()];
  }
}

/** The request's input as material, and the id of its kind. The legacy shape is the kind "transcript". */
export const LEGACY_KIND = "transcript";
export function materialOf(input: unknown): InputMaterial | null {
  const i = input as Record<string, unknown> | null;
  if (!i || typeof i !== "object") return null;
  const s = i.source as Record<string, unknown> | undefined;
  if (s && typeof s === "object") {
    if (typeof s.kind !== "string" || typeof s.text !== "string" || typeof s.title !== "string") return null;
    return { kind: s.kind, id: String(s.id ?? ""), title: s.title, text: s.text, items: Array.isArray(s.items) ? s.items : [] };
  }
  const t = i.transcript as RoomTranscript | undefined;
  if (t && typeof t.title === "string" && Array.isArray(t.turns)) {
    return { kind: LEGACY_KIND, id: "", title: t.title, text: "", items: [], transcript: t };
  }
  return null;
}

const MATERIAL_SYS = `You write a short two-host podcast script from the material you are given.
Rules:
- Use ONLY what the material says. Do not add facts, names or numbers it does not contain.
- Each spoken line starts with its host label exactly as in THE CAST, e.g. "HOST A:" or "HOST B:".
- The hosts talk to each other: a cold open, the substance in a few exchanges, a short sign-off.
- Plain spoken sentences only: no markdown, no stage directions, no lists.`;

const MAX_MATERIAL_CHARS = 24000;

/** A script from material through the gateway chat, as the team's turns. A writer that answers nothing is a refusal:
 *  the material is never voiced as it stands, and the error carries none of it. */
export async function scriptFromMaterial(
  m: { kind: string; title: string; text: string },
  team: Team,
  chat: ChatFn,
  framing: string,
): Promise<RoomTranscript> {
  const system = `${MATERIAL_SYS}\nThe material is ${framing}.\n\n${castBlock(team)}`;
  const user = `TITLE: ${m.title}\n\nMATERIAL:\n${m.text.slice(0, MAX_MATERIAL_CHARS)}`;
  const written = await chat(system, user);
  if (!written || !written.trim()) throw new Error("the script writer returned no script");
  return turnsFromHostScript(m.title, written, team);
}

function fromMaterial(id: string, label: string, personal: boolean, framing: string): InputKind {
  return {
    id, label, personal, available: true,
    toTranscript: (input, ctx) => scriptFromMaterial(input, ctx.team, ctx.chat, framing),
  };
}

export const INPUT_KINDS = new InputKindRegistry();
INPUT_KINDS.register({
  id: LEGACY_KIND, label: "a room transcript", personal: false, available: true,
  toTranscript: (input) => {
    if (!input.transcript) return Promise.reject(new Error("the request's input is not a room transcript"));
    return Promise.resolve(input.transcript);
  },
});
INPUT_KINDS.register(fromMaterial("run", "a research run", true, "the result of a research run the listener started"));
INPUT_KINDS.register(fromMaterial("report", "a report", true, "a research report that belongs to the listener"));
INPUT_KINDS.register(fromMaterial("document", "a document", true, "a document the listener wrote"));
INPUT_KINDS.register(fromMaterial("idea", "an idea", true, "an idea of the listener's own"));
INPUT_KINDS.register(fromMaterial("topic", "a topic", false, "a topic page from the shared knowledge base"));
// registered, not usable: it waits for the discussion store (rwr-disc-store-api)
INPUT_KINDS.register({
  id: "discussion", label: "a discussion", personal: true, available: false,
  toTranscript: () => Promise.reject(new Error("discussion episodes are not available yet")),
});

/** The kinds a request can carry as `source` (every registered kind but the legacy transcript). */
export const SOURCE_KINDS: readonly string[] = ["run", "report", "document", "idea", "topic"];
