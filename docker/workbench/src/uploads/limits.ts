// Upload sessions' limits and place (rwr-upload-sessions). Read from the environment once, with the anchor's defaults:
//   UPLOAD_MAX_FILE_BYTES        500 MB   one file
//   UPLOAD_MAX_UNFINISHED_BYTES  1 GB     the declared sizes of one person's unfinished (open / finishing) uploads, summed
//   UPLOAD_MAX_PIECE_BYTES       16 MB    one PUT (the forwarder's upload cap is 100 MB; the app sends 8 MB pieces)
//   UPLOAD_PIECE_BYTES           8 MB     the piece size the app is told to send
//   UPLOAD_ABANDON_HOURS         24       a session not touched for this long is swept (its pieces and its row)
//   UPLOAD_SWEEP_MS              600000   how often the sweep runs
//   UPLOAD_DIR                   /uploads the workbench's own volume (compose: openbrain-uploads); no other service mounts it
// Pure: no import of config.ts (the contract's module graph imports this file).
export const MB = 1024 * 1024;

export interface UploadLimits {
  maxFileBytes: number;
  maxUnfinishedBytes: number;
  maxPieceBytes: number;
  pieceBytes: number;
  abandonHours: number;
  sweepMs: number;
  dir: string;
}

const num = (v: string | undefined, d: number, min: number) => {
  const n = Number((v ?? "").trim());
  return v !== undefined && v.trim() !== "" && Number.isFinite(n) && n >= min ? Math.floor(n) : d;
};

export function uploadLimits(env = (k: string) => Deno.env.get(k)): UploadLimits {
  const maxPieceBytes = num(env("UPLOAD_MAX_PIECE_BYTES"), 16 * MB, 1);
  return {
    maxFileBytes: num(env("UPLOAD_MAX_FILE_BYTES"), 500 * MB, 1),
    maxUnfinishedBytes: num(env("UPLOAD_MAX_UNFINISHED_BYTES"), 1024 * MB, 1),
    maxPieceBytes,
    pieceBytes: Math.min(num(env("UPLOAD_PIECE_BYTES"), 8 * MB, 1), maxPieceBytes),
    abandonHours: num(env("UPLOAD_ABANDON_HOURS"), 24, 0),
    sweepMs: num(env("UPLOAD_SWEEP_MS"), 600_000, 100),
    dir: (env("UPLOAD_DIR") ?? "").trim() || "/uploads",
  };
}
