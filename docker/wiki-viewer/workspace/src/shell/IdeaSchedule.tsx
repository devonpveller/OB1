// rw-idea-schedule: the user's own "when does research on my ideas start" setting, in Settings.
// Immediately (the default), daily at HH:MM, or weekly on a day at HH:MM, in a time zone that
// defaults to the browser's. Reads and writes /workbench/idea-schedule (the caller's subject only).
import { useEffect, useState } from "react";
import { ApiError, api, get } from "../lib/api";

export const SCHEDULE_URL = "/workbench/idea-schedule";
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

function browserTz(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function IdeaSchedule() {
  const [mode, setMode] = useState("immediate");
  const [time, setTime] = useState("09:00");
  const [weekday, setWeekday] = useState("1");
  const [tz, setTz] = useState(browserTz());
  const [next, setNext] = useState<string | null>(null);
  const [msg, setMsg] = useState("");
  const apply = (s: any) => {
    setMode(s.mode ?? "immediate");
    if (s.at_time) setTime(s.at_time);
    if (s.weekday) setWeekday(String(s.weekday));
    if (s.mode && s.mode !== "immediate" && s.tz) setTz(s.tz);
    setNext(s.next_start ?? null);
  };
  useEffect(() => {
    let live = true;
    get(SCHEDULE_URL).then((s) => live && apply(s)).catch((e) => live && setMsg(String((e as Error).message)));
    return () => {
      live = false;
    };
  }, []);
  const save = async () => {
    try {
      const body = {
        mode,
        at_time: mode === "immediate" ? null : time,
        weekday: mode === "weekly" ? Number(weekday) : null,
        tz: tz.trim() || browserTz(),
      };
      const r = await api("PUT", SCHEDULE_URL, body);
      apply({ ...body, ...r.data });
      setMsg("saved");
    } catch (e) {
      setMsg(e instanceof ApiError ? String(e.body?.error ?? e.message) : String((e as Error).message));
    }
  };
  return (
    <fieldset className="ws-idea-schedule" data-testid="idea-schedule">
      <legend>Start research on my ideas</legend>
      <label>
        When{" "}
        <select data-field="mode" value={mode} onChange={(e) => setMode(e.target.value)}>
          <option value="immediate">Immediately</option>
          <option value="daily">Daily at a time</option>
          <option value="weekly">Weekly on a day</option>
        </select>
      </label>
      {mode === "weekly" && (
        <label>
          {" "}Day{" "}
          <select data-field="weekday" value={weekday} onChange={(e) => setWeekday(e.target.value)}>
            {DAYS.map((d, i) => <option key={d} value={String(i + 1)}>{d}</option>)}
          </select>
        </label>
      )}
      {mode !== "immediate" && (
        <>
          <label>
            {" "}At{" "}
            <input data-field="at_time" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
          </label>
          <label>
            {" "}Time zone{" "}
            <input data-field="tz" value={tz} onChange={(e) => setTz(e.target.value)} />
          </label>
        </>
      )}
      {mode === "immediate" && <input data-field="tz" type="hidden" value={tz} readOnly />}
      <button type="button" data-action="save-schedule" onClick={save}>Save</button>
      <p className="ws-muted">Ideas appear in the refinery at once; "Research now" always starts one immediately.</p>
      {next && <p className="ws-muted" data-testid="idea-schedule-next">Next start: {next}</p>}
      {msg && <p className="ws-muted" data-testid="idea-schedule-msg">{msg}</p>}
    </fieldset>
  );
}
