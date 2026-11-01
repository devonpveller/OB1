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

export const CONTRACT_VERSION = "0.3.0"; // 0.2.0: P2a reference records; 0.3.0: P4b running sessions + P7a podcasts (additive)

export function createContractApp(deps: ContractDeps) {
  const app = newApp();
  registerAppendix(app, deps);
  registerLifecycle(app, deps);
  registerRefinery(app, deps);
  registerReferences(app, deps);
  registerSystem(app, deps);
  registerPodcasts(app, deps);
  registerSessions(app, deps);
  registerTrust(app, deps); // P3b: the trust panels' reads
  registerCleanup(app, deps); // P8a (rw-p8a2-cleanup): the cleanup view
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
