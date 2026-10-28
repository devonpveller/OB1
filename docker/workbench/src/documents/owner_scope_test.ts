// The owner scope's path finder (src/middleware/owner-scope.ts): every way a request can name a
// documents/ path is found, after `..` resolution; the documents API's own route names are not paths.
import { assertEquals } from "jsr:@std/assert@1";
import { documentPathsIn } from "../middleware/owner-scope.ts";

Deno.test("owner scope: documents/ paths are found wherever a request string names one", () => {
  assertEquals(documentPathsIn("documents/bee/x.md"), ["documents/bee/x.md"]);
  assertEquals(documentPathsIn("notes/../documents/bee/x.md"), ["documents/bee/x.md"]);
  assertEquals(documentPathsIn("documents/ant/../bee/x.md"), ["documents/bee/x.md"]);
  assertEquals(documentPathsIn("document:documents/bee/x.md"), ["documents/bee/x.md"]);
  assertEquals(documentPathsIn("/workbench/export/documents/bee/x.md"), ["documents/bee/x.md"]);
  assertEquals(documentPathsIn("documents"), []);
  assertEquals(documentPathsIn("notes/plain.md"), []);
  assertEquals(documentPathsIn("my documents are here"), []);
});
