// mm-privacy.test.ts - the refinery's Mattermost channel rule (rw-idea-privacy).   deno test mm-privacy.test.ts
import { channelRefusal } from "./mm-privacy.ts";

function eq(a: unknown, b: unknown, m = "") {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
const owner = { user_id: "u-owner", is_bot: false };
const second = { user_id: "u-second", is_bot: false };
const bot = { user_id: "u-bot", is_bot: true };

Deno.test("a PUBLIC channel is refused whoever is in it (#ideas was created type O)", () => {
  eq(channelRefusal("O", [owner, bot]).startsWith("is not private"), true);
  eq(channelRefusal("O", []).startsWith("is not private"), true);
});
Deno.test("a private channel or a DM with a second human member is refused", () => {
  eq(channelRefusal("P", [owner, second, bot]).startsWith("has 2 human members"), true);
  eq(channelRefusal("D", [owner, second]).startsWith("has 2 human members"), true);
  eq(channelRefusal("G", [owner, bot]).startsWith("is not private"), true, "a group message is not a one-person channel");
});
Deno.test("a private channel or DM whose one human is the reader is allowed; bots are not readers", () => {
  eq(channelRefusal("P", [owner, bot]), "");
  eq(channelRefusal("D", [owner, bot]), "");
  eq(channelRefusal("P", [bot]), "");
});
Deno.test("an unknown type is refused", () => {
  eq(channelRefusal("", [owner]).startsWith("is not private"), true);
});
