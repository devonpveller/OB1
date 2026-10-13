// link-enrich.ts end-to-end against a stub gateway (mr-routine-outage).
//
// The REAL runner (link-enrich.ts --commit) as a subprocess, exactly as
// openbrain-podcast spawns it (same ROUTINE_* env), in real time, against:
// a stub LLM gateway (down = the exact 2026-10-13 502 body), a stub brain
// (one newsletter, body-only), a stub research engine speaking the
// mr-research-failfast interface (model_down signal). Egress is fail-closed:
// HTTP(S)_PROXY points at a dead port with NO_PROXY=loopback, so any request
// to a real host fails.
//
// Run: deno test --allow-all src/enrich/link-enrich.e2e.test.ts
import { assert, assertEquals, assertMatch } from "jsr:@std/assert@1";
import { brainStub, gatewayStub, guardNetwork, stubServer } from "../routine/testing.ts";
import { dirOf } from "../podcast/podcast-service.ts";

guardNetwork();
const RECIPE = dirOf(new URL("../../link-enrich.ts", import.meta.url).href);
const DATE = "2026-10-13";

interface Engine {
  url: string;
  submits: number[];
  /** per submit: "done" | "model_down" */
  plan: string[];
  onSubmit?: (n: number) => void;
  close(): Promise<void>;
}

function researchStub(plan: string[]): Engine {
  const e = { submits: [] as number[], plan } as Engine;
  const jobs = new Map<string, string>();
  const s = stubServer(async (req, path) => {
    if (req.method === "POST" && path === "/research") {
      await req.json();
      const n = e.submits.length;
      e.submits.push(Date.now());
      const id = `00000000-0000-0000-0000-00000000000${n}`;
      jobs.set(id, e.plan[n] ?? "done");
      e.onSubmit?.(n);
      return Response.json({ job_id: id, status: "queued" }, { status: 202 });
    }
    const m = /^\/research\/jobs\/([^/]+)(\/cancel)?$/.exec(path);
    if (m && m[2]) return Response.json({ status: "cancelled" });
    if (m) {
      const kind = jobs.get(m[1]);
      if (kind === "model_down") {
        return Response.json({
          id: m[1],
          status: "error",
          error: "model_down: chat 502: upstream unreachable",
          progress: { code: "model_down", phase: "model_down" },
          model: { state: "down" },
        });
      }
      return Response.json({
        id: m[1],
        status: "done",
        result: {
          synthesis: "[SOURCED] Routing recovers after an outage [Source 1]\n[SOURCED] The brief waits for the model [Source 1]",
          reuse_claims: [],
        },
      });
    }
    return new Response("nf", { status: 404 });
  });
  return Object.assign(e, s);
}

async function runLinkEnrich(o: { gwUrl: string; brainUrl: string; researchUrl: string; dir: string; waitUntil?: number }) {
  const out = await new Deno.Command("deno", {
    args: ["run", "--unstable-net", "-A", "link-enrich.ts", "--commit"],
    cwd: RECIPE,
    env: {
      MCP_ACCESS_KEY: "test",
      BRAIN_REST_URL: o.brainUrl,
      RESEARCH_URL: o.researchUrl,
      CHAT_API_BASE: `${o.gwUrl}/v1`,
      CHAT_API_KEY: "sk-test",
      REPORTS_DIR: `${o.dir}/reports`,
      FETCH_PROXY_URL: "",
      GAP_DIVE_ENABLED: "0",
      GMAIL_READ_CREDENTIALS: `${o.dir}/absent-credentials.json`,
      GMAIL_READ_TOKEN: `${o.dir}/absent-token.json`,
      ROUTINE_DATE: DATE,
      ROUTINE_STATE_DIR: `${o.dir}/reports/routine`,
      MODEL_WAIT_UNTIL_MS: String(o.waitUntil ?? Date.now() + 60_000),
      MODEL_GATE_INITIAL_MS: "200",
      MODEL_GATE_MAX_MS: "500",
      RESEARCH_POLL_MS: "100",
      RESEARCH_WAIT_MS: "20000",
      // fail closed: nothing may leave the machine
      HTTP_PROXY: "http://127.0.0.1:9",
      HTTPS_PROXY: "http://127.0.0.1:9",
      NO_PROXY: "127.0.0.1,localhost",
    },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const td = new TextDecoder();
  return { code: out.code, log: td.decode(out.stdout) + td.decode(out.stderr) };
}

async function setup(gwMode: "up" | "down", plan: string[]) {
  const dir = await Deno.makeTempDir({ prefix: "link-enrich-e2e-" });
  const gw = gatewayStub(gwMode);
  const brain = brainStub();
  const engine = researchStub(plan);
  return {
    dir,
    gw,
    brain,
    engine,
    async close() {
      await Promise.all([gw.close(), brain.close(), engine.close()]);
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    },
  };
}

const readJson = async (p: string) => {
  try {
    return JSON.parse(await Deno.readTextFile(p));
  } catch {
    return null;
  }
};

Deno.test({
  name: "L1 model down at start: link-enrich WAITS (no model work, no research) and runs fully once it is back",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const t = await setup("down", ["done"]);
    let upAt = 0;
    const timer = setTimeout(() => {
      upAt = Date.now();
      t.gw.mode = "up";
    }, 3_000);
    try {
      const r = await runLinkEnrich({ gwUrl: t.gw.url, brainUrl: t.brain.url, researchUrl: t.engine.url, dir: t.dir });
      assertEquals(r.code, 0, r.log.slice(-2000));
      assert(upAt > 0);
      assertMatch(r.log, /model DOWN \(chat 502 upstream unreachable\); waiting - no degraded run/);
      const early = t.gw.work().filter((w) => w.at < upAt);
      assertEquals(early.length, 0, "no model work while the model was down");
      assert(t.engine.submits.length === 1 && t.engine.submits[0] >= upAt, "research submitted only after the model came back");
      assert(t.gw.work().length > 0, "model work happened after it came back");
      const brief = await readJson(`${t.dir}/reports/podcast-brief-latest.json`);
      assertEquals(brief?.routineDate, DATE);
      assert(brief?.episode, "the episode was produced");
      assertEquals(brief.segments[0].items[0].emailOnly, false, "researched, not an email-only fallback");
      assertEquals((await readJson(`${t.dir}/reports/routine/${DATE}.podcast-result.json`))?.outcome, "produced");
      assertEquals(t.gw.healthGets(), 0, "never GET /health");
    } finally {
      clearTimeout(timer);
      await t.close();
    }
  },
});

Deno.test({
  name: "L2 model down past the wait bound: exit 3, NO brief, result model-down, zero research submits (no degraded run)",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const t = await setup("down", ["done"]);
    try {
      const r = await runLinkEnrich({ gwUrl: t.gw.url, brainUrl: t.brain.url, researchUrl: t.engine.url, dir: t.dir, waitUntil: Date.now() + 2_500 });
      assertEquals(r.code, 3, r.log.slice(-2000));
      assertMatch(r.log, /STOPPED: model down at stage "links"/);
      assertEquals(t.engine.submits.length, 0);
      assertEquals(t.gw.work().length, 0);
      assertEquals(await readJson(`${t.dir}/reports/podcast-brief-latest.json`), null);
      assertEquals((await readJson(`${t.dir}/reports/routine/${DATE}.podcast-result.json`))?.outcome, "model-down");
    } finally {
      await t.close();
    }
  },
});

Deno.test({
  name: "L3 the model goes down UNDER a research job (engine says model_down): link-enrich waits, resubmits, and the item is researched - not email-only",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const t = await setup("up", ["model_down", "done"]);
    let upAt = 0;
    t.engine.onSubmit = (n) => {
      if (n === 0) {
        t.gw.mode = "down";
        setTimeout(() => {
          upAt = Date.now();
          t.gw.mode = "up";
        }, 2_000);
      }
    };
    try {
      const r = await runLinkEnrich({ gwUrl: t.gw.url, brainUrl: t.brain.url, researchUrl: t.engine.url, dir: t.dir });
      assertEquals(r.code, 0, r.log.slice(-2000));
      assertEquals(t.engine.submits.length, 2, "resubmitted once");
      assert(t.engine.submits[1] >= upAt && upAt > 0, "resubmitted only after the model was back");
      assertMatch(r.log, /the model went down under job/);
      const brief = await readJson(`${t.dir}/reports/podcast-brief-latest.json`);
      assertEquals(brief.segments[0].items[0].emailOnly, false);
      assertMatch(JSON.stringify(brief.segments[0].items[0].keyPoints), /Routing recovers/);
    } finally {
      await t.close();
    }
  },
});
