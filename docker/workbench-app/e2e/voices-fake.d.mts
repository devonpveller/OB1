export const NO_SUCH: { voice: string; presenter: string; team: string; format: string };
export const MAX_SEATS: number;
export const KINDS: string[];
export const USES: string[];
export const MODES: string[];
export const NAME_TAKEN: string;
export const ID_RE: RegExp;
export const ROUTE_RE: RegExp;
export const VOICE_RE: RegExp;
export const LANG_RE: RegExp;
export type Who = "alice" | "bob" | "nobody";
export type Answer = { status: number; body: any; wav?: Uint8Array };
export function createFake(o?: { now?: () => number }): {
  handle(method: string, url: string, body?: any, who?: Who): Answer;
  hook(name: string, arg?: any): any;
  seed: {
    voice(owner: string, o?: any): string;
    presenter(owner: string, o?: any): string;
    team(owner: string, o?: any): string;
    format(owner: string, o?: any): string;
  };
  t: { voices: Map<string, any>; presenters: Map<string, any>; teams: Map<string, any>; formats: Map<string, any> };
  log: { method: string; url: string; who: string }[];
  people: Record<Who, { sub: string; name: string }>;
  state: { mode: Who; sample: "ok" | "unset" | "down"; failList: boolean; hang: boolean; samples: { sub: string; id: string; route: string; voice: string; speed: number }[] };
  iso(): string;
};
