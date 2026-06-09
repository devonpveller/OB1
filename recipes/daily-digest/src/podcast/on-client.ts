/**
 * Open Notebook podcast client (S4b / P4).
 *
 * ON is the AUDIO backend (D5): we hand it the day's GROUNDED script as `content`
 * (never a notebook_id — ON does no gathering) plus a grounding briefing, and it
 * writes the multi-speaker transcript + voices it with local Piper TTS. Per D12
 * we accept ON's conversational expansion (facts stay grounded, the briefing
 * holds the preliminary/gap framing).
 *
 * This is the swappable audio seam — when Quartz-4 P7's in-stack TTS lands, only
 * this client changes; S4a (the script) stays.
 *
 * Contract (open-notebook fork, api/routers/podcasts.py):
 *   POST /api/podcasts/generate {episode_profile,speaker_profile,episode_name,content,briefing_suffix}
 *        -> { job_id, status }
 *   GET  /api/podcasts/jobs/{job_id}           -> { status }
 *   GET  /api/podcasts/episodes                -> [{ id, name, audio_file, audio_url, job_status }]
 *   GET  /api/podcasts/episodes/{id}/audio     -> mp3 stream
 */

export interface GenerateArgs {
  episodeProfile: string; // ON episode profile name, e.g. "tech_discussion"
  speakerProfile: string; // ON speaker profile name, e.g. "tech_experts"
  episodeName: string; // our [###]-daily-[topic]
  content: string; // the grounded script
  briefingSuffix?: string;
}

export interface OnEpisode {
  id: string;
  name: string;
  audioUrl?: string | null; // relative, e.g. /api/podcasts/episodes/{id}/audio
  audioFile?: string | null;
  jobStatus?: string | null;
  errorMessage?: string | null;
}

const TERMINAL = new Set(["completed", "failed", "error", "cancelled"]);

export interface OnClientOptions {
  baseUrl: string; // e.g. http://open_notebook:5055
  timeoutMs?: number;
}

export class OnClient {
  private readonly baseUrl: string;
  constructor(private readonly opts: OnClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
  }

  /** Submit a generation job; returns job_id. */
  async generate(args: GenerateArgs): Promise<string> {
    const res = await fetch(`${this.baseUrl}/api/podcasts/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        episode_profile: args.episodeProfile,
        speaker_profile: args.speakerProfile,
        episode_name: args.episodeName,
        content: args.content,
        briefing_suffix: args.briefingSuffix,
      }),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 30_000),
    });
    if (!res.ok) {
      throw new Error(`ON generate failed: ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
    }
    const d = await res.json() as { job_id?: string };
    if (!d.job_id) throw new Error("ON generate: no job_id");
    return d.job_id;
  }

  async jobStatus(jobId: string): Promise<string> {
    const res = await fetch(
      `${this.baseUrl}/api/podcasts/jobs/${encodeURIComponent(jobId)}`,
      { signal: AbortSignal.timeout(this.opts.timeoutMs ?? 30_000) },
    );
    if (!res.ok) throw new Error(`ON job poll failed: ${res.status}`);
    const d = await res.json() as { status?: string };
    return d.status ?? "unknown";
  }

  /** Poll until the job is terminal or the deadline elapses. TTS is minutes. */
  async waitForJob(jobId: string, opts: { timeoutMs?: number; intervalMs?: number } = {}): Promise<string> {
    const deadline = Date.now() + (opts.timeoutMs ?? 900_000); // 15 min
    const interval = opts.intervalMs ?? 12_000;
    let last = "unknown";
    while (Date.now() < deadline) {
      last = await this.jobStatus(jobId);
      if (TERMINAL.has(last)) return last;
      await new Promise((r) => setTimeout(r, interval));
    }
    throw new Error(`ON job ${jobId} did not finish within deadline (last: ${last})`);
  }

  /** Find the produced episode by name (newest match). */
  async episodeByName(name: string): Promise<OnEpisode | null> {
    const res = await fetch(`${this.baseUrl}/api/podcasts/episodes`, {
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 30_000),
    });
    if (!res.ok) return null;
    const list = await res.json() as Array<{
      id: string; name: string; audio_file?: string | null; audio_url?: string | null;
      job_status?: string | null; error_message?: string | null;
    }>;
    const hit = list.find((e) => e.name === name) ?? null;
    if (!hit) return null;
    return {
      id: hit.id, name: hit.name, audioUrl: hit.audio_url, audioFile: hit.audio_file,
      jobStatus: hit.job_status, errorMessage: hit.error_message,
    };
  }

  /** Absolute URL for an episode's audio (for the email link-back / logs). */
  audioUrlFor(ep: OnEpisode): string | null {
    return ep.audioUrl ? `${this.baseUrl}${ep.audioUrl}` : null;
  }
}
