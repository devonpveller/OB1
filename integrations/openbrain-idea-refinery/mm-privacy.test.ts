// mm-privacy.test.ts - the refinery's Mattermost channel rule (rw-idea-privacy).   deno test mm-privacy.test.ts
import { channelRefusal } from "./mm-privacy.ts";

function eq(a: unknown, b: unknown, m = "") {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
const owner = { user_id: "u-owner", username: "owner", is_bot: false };
const second = { user_id: "u-second", username: "second", is_bot: false };
const bot = { user_id: "u-bot", username: "refinery-bot", is_bot: true };
const R = new Set(["owner"]);

Deno.test("a PUBLIC channel is refused whoever is in it (#ideas was created type O)", () => {
  eq(channelRefusal("O", [owner, bot], R).startsWith("is not private"), true);
  eq(channelRefusal("O", [], R).startsWith("is not private"), true);
});
Deno.test("a private channel or a DM with a second human member is refused", () => {
  eq(channelRefusal("P", [owner, second, bot], R).startsWith("has 2 human members"), true);
  eq(channelRefusal("D", [owner, second], R).startsWith("has 2 human members"), true);
  eq(channelRefusal("G", [owner, bot], R).startsWith("is not private"), true, "a group message is not a one-person channel");
});
Deno.test("a private channel or DM whose one human is the reader is allowed; bots are not readers", () => {
  eq(channelRefusal("P", [owner, bot], R), "");
  eq(channelRefusal("D", [owner, bot], R), "");
  eq(channelRefusal("P", [bot], R), "");
});
Deno.test("an unknown type is refused", () => {
  eq(channelRefusal("", [owner], R).startsWith("is not private"), true);
});

Deno.test("a private channel or DM whose one human is NOT an authorised reader is refused (the owner itself cannot be checked: no mapping)", () => {
  eq(channelRefusal("P", [second, bot], R).startsWith("has a human member who is not an authorised reader"), true);
  eq(channelRefusal("D", [owner, bot], new Set()).startsWith("has a human member who is not an authorised reader"), true, "no readers configured = nobody");
});
Deno.test("index.ts checks the channel right before EVERY brainstorm post (the late gap-research post included)", async () => {
  const src = (await Deno.readTextFile(new URL("./index.ts", import.meta.url))).replace(/\/\/.*$/gm, "");
  const body = src.slice(src.indexOf("async function privatePost("), src.indexOf("async function mmPost("));
  const rest = src.replace(body, "");
  const posts = [...rest.matchAll(/await (mmPost|privatePost)\(/g)].map((m) => m[1]);
  eq(posts.filter((p) => p === "mmPost").length, 0, "a direct mmPost call bypasses the check");
  eq(posts.filter((p) => p === "privatePost").length >= 4, true);
  eq(/await assertPrivate\(channelId, null\);[\s\S]*return await mmPost\(/.test(body), true, "privatePost checks, then posts");
});
