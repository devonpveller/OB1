export const ARCHIVED_MSG: string;
export const NOT_WAITING: string;
export const UNCONFIGURED: string;
export type Who = "alice" | "bob" | "nobody";
export type Answer = { status: number; body: any };
export function createFake(o?: { now?: () => number }): {
  handle(method: string, url: string, body?: any, who?: Who): Answer;
  hook(name: string, arg?: any): any;
  addIdea(owner: string, o: any): string;
  ideas: Map<string, any>;
  sessions: Map<string, any>;
  log: { method: string; url: string; who: string }[];
  people: Record<Who, { sub: string; name: string }>;
  state: { mode: Who; failList: boolean; hang: boolean; researchConfigured: boolean };
  iso(msAgo?: number): string;
  H: number;
  D: number;
};
