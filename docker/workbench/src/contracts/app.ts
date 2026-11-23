// The retrieval contract, assembled: one OpenAPIHono app whose routes ARE the OpenAPI
// document, so the document cannot list a call the service does not answer, or miss one it does.
import { newApp, type ContractDeps } from "./routes/http.ts";
import { registerAppendix } from "./routes/appendix.ts";
import { registerLifecycle } from "./routes/lifecycle.ts";
import { registerRefinery } from "./routes/refinery.ts";
import { registerReferences } from "./routes/references.ts";
import { registerSystem } from "./routes/system.ts";
import { registerPodcasts } from "./routes/podcasts.ts";
import { registerSessions } from "./routes/sessions.ts";
import { registerTrust } from "./routes/trust.ts";
import { registerCleanup } from "./routes/cleanup.ts";
import { registerLibrary } from "./routes/library.ts";
import { registerFlags } from "./routes/flags.ts";
import { registerInlets } from "./routes/inlets.ts";
import { registerResearchStart } from "./routes/research_start.ts";
import { tombstoneActorMask } from "./routes/actor_mask.ts";
import { registerPrivate } from "./routes/private.ts";

export const CONTRACT_VERSION = "0.4.0"; // 0.2.0: P2a reference records; 0.3.0: P4b running sessions + P7a podcasts; 0.4.0: P8a core panels (source-states, the lift rule) + the cleanup view (additive)

export function createContractApp(deps: ContractDeps) {
  const app = newApp();
  // rw-p8a2-cleanup round 3: a tombstone's eraser / lifter is named only to that user (routes/actor_mask.ts)
  app.use("*", tombstoneActorMask());
  registerAppendix(app, deps);
  registerLifecycle(app, deps);
  registerRefinery(app, deps);
  registerReferences(app, deps);
  registerSystem(app, deps);
  registerPodcasts(app, deps);
  registerSessions(app, deps);
  registerTrust(app, deps); // P3b: the trust panels' reads
  registerCleanup(app, deps); // P8a (rw-p8a2-cleanup): the cleanup view
  registerLibrary(app, deps); // rwr-home round 4: the shared-library reads behind the Home library cards
  registerFlags(app, deps); // rwr-flags-api: flag for cleanup (per user)
  registerInlets(app, deps); // rwr-imports-server-api (slot 600): the caller's own inlet connections
  registerPrivate(app, deps); // rw-owner-private-view (slot 480): the owner's private views (no MCP tool)
  registerResearchStart(app, deps); // rwr-research-start-api: POST /workbench/research and /research/preview
  app.openAPIRegistry.registerComponent("securitySchemes", "brainKey", {
    type: "apiKey", in: "header", name: "X-Brain-Key",
    description: "the shared secret the door injects (the viewer's /workbench forwarder; G7); the browser never holds it",
  });
  return app;
}

export function openApiDocument(app: ReturnType<typeof createContractApp>) {
  return app.getOpenAPIDocument({
    openapi: "3.0.3",
    info: {
      title: "Open Brain retrieval contract",
      version: CONTRACT_VERSION,
      description: "The typed retrieval contract every panel and MCP client reads the knowledge base " +
        "through (research-workbench P0). The API owns record states; every enumerated kind is a " +
        "registry (x-registry), never a closed list.",
    },
    security: [{ brainKey: [] }],
  });
}
