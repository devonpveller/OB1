/**
 * RoutineNotice - a box at the top of a digest that says what did NOT finish
 * (mr-routine-outage). Not a Section (it has no data source): the routine
 * builds it from the day's state and hands it to the orchestrator.
 *
 * C5: a section that did not run is shown as "still running" / "failed" /
 * "waiting for the model", never silently left out as if it were done.
 */

export interface RoutineNoticePayload {
  tone: "pending" | "failed" | "info";
  title: string;
  lines: string[];
}
