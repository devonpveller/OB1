export const ACTIVE: string[];
export const CANCELLABLE: string[];
export const KINDS: string[];
export function actionsOf(status: string): { actions: string[]; primary: string };
export function createFake(): {
  handle(req: { who: string; method: string; path: string; query?: Record<string, string>; json?: any; form?: any }): { status: number; body: any } | null;
  seed(owner: string, fields?: Record<string, any>): any;
  set(id: string, status: string, error?: string | null): any;
  jobs: Map<string, any>;
  docs: { owner: string; path: string; title: string; refinery: boolean }[];
  ideas: { owner: string; id: string; title: string; status: string }[];
  log: { who: string; method: string; path: string }[];
  shape(j: any): any;
};
