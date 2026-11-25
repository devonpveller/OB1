// Types for e2e/runs-fake.mjs (loose on purpose: the fake is test support).
export const PREFIX: string;
export function groupOf(status: string, openBranches: number): "running" | "queued" | "done" | "stopped";
export type FakeAnswer = { status: number; body?: any; stream?: boolean; run?: any; mine?: boolean } | null;
export function createRunsFake(opts?: { now?: () => number }): {
  state: any;
  addRun(r: any): any;
  addNode(run: any, n: any): any;
  handle(method: string, url: string, body: any, sub: string): FakeAnswer;
  sse(run: any, mine: boolean, name?: string): string;
  cardEvent(run: any, mine: boolean): any;
  listen(runId: string, f: () => void): () => void;
  emit(runId: string): void;
  grow(runId: string, n: any): any;
  finish(runId: string, status?: string): void;
  find(runId: string): any;
  rowOf(run: any, sub: string): any;
  id(p?: string): string;
};
