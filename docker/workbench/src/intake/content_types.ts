// The intake's declared content types (rw-p5a-intake; the ingestion brainstorm 2026-09-25): a web page,
// a PDF and a YouTube transcript - keys of public.content_types. ONE list, read by the one add path that
// every inlet enters (the panel's general and contextual adds, the OWUI inlet), so no inlet can accept a
// type another refuses. The research service declares the same three (intake-fetch.ts
// INTAKE_CONTENT_TYPES); intake_test.ts checks the two lists are equal.
export const INTAKE_CONTENT_TYPES = ["web_article", "pdf", "youtube_transcript"] as const;
export type IntakeContentType = typeof INTAKE_CONTENT_TYPES[number];

export const CONTENT_TYPE_LABELS: Record<IntakeContentType, string> = {
  web_article: "web page",
  pdf: "PDF",
  youtube_transcript: "YouTube transcript",
};

export function isIntakeContentType(v: unknown): v is IntakeContentType {
  return typeof v === "string" && (INTAKE_CONTENT_TYPES as readonly string[]).includes(v);
}

// A FILE added (picked or dropped): a PDF, or a saved web page. A YouTube transcript is a link only.
// Anything else is refused with the same answer whichever inlet sent it.
export function fileContentType(filename: string, bytes: Uint8Array): IntakeContentType | null {
  const head = new TextDecoder().decode(bytes.subarray(0, 512)).trimStart().toLowerCase();
  if (head.startsWith("%pdf-")) return "pdf";
  const name = filename.toLowerCase();
  if (/\.(html?|xhtml)$/.test(name) && (head.startsWith("<!doctype html") || head.startsWith("<html") || head.startsWith("<"))) return "web_article";
  return null;
}
