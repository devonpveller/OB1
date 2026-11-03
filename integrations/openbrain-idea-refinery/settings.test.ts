// deno test settings.test.ts - rw-settings-store: the refinery's reads of an owner's settings fall back to the
// env value whenever nothing is stored (or the store is not there), and use a stored value when it is.
import { ownerSetting, settingBool, settingNumber } from "./settings.ts";

const eq = (a: unknown, b: unknown, m: string) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
};

Deno.test("no owner, no stored value, or no setting_get: the env value", async () => {
  let calls = 0;
  const none = <T>() => { calls++; return Promise.resolve([{ v: null }] as T[]); };
  eq(await ownerSetting(none, null, "refinery.dormancy_days"), null, "no owner");
  eq(calls, 0, "no owner asks nothing");
  eq(settingNumber(await ownerSetting(none, "alice", "refinery.dormancy_days"), 14, 1, 365), 14, "nothing stored");
  const missing = <T>(): Promise<T[]> => Promise.reject(Object.assign(new Error("function public.setting_get does not exist"), { fields: { code: "42883" } }));
  eq(settingNumber(await ownerSetting(missing, "alice", "refinery.dormancy_days"), 14, 1, 365), 14, "slot 400 not applied");
  eq(settingBool(await ownerSetting(missing, "alice", "refinery.brainstorm"), true), true, "brainstorm default on");
});

Deno.test("a stored value is the one read, per owner", async () => {
  const store: Record<string, unknown> = { "alice|refinery.dormancy_days": 3, "alice|refinery.brainstorm": false, "bob|refinery.resurface_max_dist": 0.2 };
  const sql = <T>(_t: string, a: unknown[] = []) => Promise.resolve([{ v: store[`${a[0]}|${a[1]}`] ?? null }] as T[]);
  eq(settingNumber(await ownerSetting(sql, "alice", "refinery.dormancy_days"), 14, 1, 365), 3, "alice's horizon");
  eq(settingNumber(await ownerSetting(sql, "bob", "refinery.dormancy_days"), 14, 1, 365), 14, "bob's default");
  eq(settingBool(await ownerSetting(sql, "alice", "refinery.brainstorm"), true), false, "alice turned brainstorm off");
  eq(settingNumber(await ownerSetting(sql, "bob", "refinery.resurface_max_dist"), 0.4, 0.05, 1), 0.2, "bob's resurface");
  eq(settingNumber(5, 0.4, 0.05, 1), 0.4, "an out-of-range value is not used");
});
