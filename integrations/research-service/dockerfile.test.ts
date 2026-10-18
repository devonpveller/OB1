/**
 * The image build runs the test suite (research-workbench P3a acceptance: "an image that only
 * deno-checks FAILS"). Static half; the build itself is the test plan's disposable docker build.
 * Run: deno test --allow-read dockerfile.test.ts
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const ignore = (() => { try { Deno.statSync(new URL("./Dockerfile", import.meta.url)); return false; } catch { return true; } })();

Deno.test({ name: "the Dockerfile's test stage runs deno test and the runtime stage depends on it", ignore, fn() {
  const text = Deno.readTextFileSync(new URL("./Dockerfile", import.meta.url));
  const stages = text.split(/^FROM /m).slice(1).map((s) => "FROM " + s);
  assertEquals(stages.length, 2, "a test stage and a runtime stage");
  const [test, runtime] = stages;
  assert(/^FROM \S+ AS test$/m.test(test), "the first stage is named `test`");
  const run = test.match(/^RUN deno test\b.*$/m)?.[0] ?? "";
  assert(run, "the test stage RUNs deno test");
  assert(run.includes("touch /app/.tests-passed"), "the marker is written only when the suite passed (&&)");
  assert(test.indexOf("COPY fixtures") < test.indexOf("RUN deno test"), "the fixtures are in the test stage");
  assert(/^COPY --from=test \/app\/\.tests-passed /m.test(runtime), "the runtime stage copies the marker, so BuildKit cannot skip the tests");
  assert(/^COPY --from=test \/app\/\*\.ts \.\/$/m.test(runtime), "the runtime ships the files the test stage passed");
  assert(!/^RUN rm -f \.\/\*\.test\.ts/m.test(test), "tests are not stripped before they run");
  assert(/^RUN deno check index\.ts$/m.test(runtime), "the module-graph check stays");
  assert(!/tor:9050|Tor SOCKS/i.test(text), "the stale Tor egress comment is gone");
} });
