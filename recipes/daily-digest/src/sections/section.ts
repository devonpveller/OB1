/**
 * Section contract.
 *
 * Every part of the digest (weather, calendar, AI news, todos, ...) is a
 * Section. The orchestrator runs all sections in parallel, drops the ones
 * that return null, and hands the rest to the renderers.
 *
 * SOLID notes:
 *  - Single Responsibility: a section knows how to build its own payload
 *    and nothing else (no rendering, no transport).
 *  - Open/Closed: adding a new section means a new file under sections/
 *    and one line in the orchestrator's section list. No edits here.
 *  - Liskov: sections are interchangeable from the orchestrator's view.
 *  - Interface Segregation: the contract is two members — name + produce.
 *  - Dependency Inversion: sections receive their clients via constructor
 *    injection, not by importing concrete singletons.
 */

export type SectionKind =
  | "weather"
  | "ai_news"
  | "calendar"
  | "todos";

/** What a section returns to the renderers. Payload is section-typed. */
export interface SectionData<P = unknown> {
  kind: SectionKind;
  payload: P;
}

/** Every digest section implements this. */
export interface Section {
  /** Stable identifier for ordering, logging, and the orchestrator. */
  readonly name: string;

  /**
   * Build the section's payload. Returns null when the section should be
   * omitted from this run (e.g. no profile_field/address set → no weather
   * card). Errors thrown here are caught by the orchestrator and logged;
   * a section failure does not fail the whole digest.
   */
  produce(): Promise<SectionData | null>;
}
