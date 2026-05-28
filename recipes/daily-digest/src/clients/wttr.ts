/**
 * WttrClient — fetches one location's structured forecast from wttr.in.
 * Returns null on network/parse failure so callers can render the
 * digest without weather rather than failing the whole run.
 *
 * wttr.in is a free public weather service (no key, no account). Same
 * trust profile as the Gmail data source already in use.
 */

export interface WttrCurrent {
  temp_F: string;
  temp_C: string;
  FeelsLikeF: string;
  FeelsLikeC: string;
  weatherDesc: Array<{ value: string }>;
  humidity: string;
  windspeedMiles: string;
  winddir16Point: string;
}

export interface WttrHourly {
  time: string;
  tempF: string;
  tempC: string;
  weatherDesc: Array<{ value: string }>;
  chanceofrain: string;
}

export interface WttrDay {
  date: string;
  maxtempF: string;
  maxtempC: string;
  mintempF: string;
  mintempC: string;
  hourly: WttrHourly[];
}

export interface WttrPayload {
  current_condition: WttrCurrent[];
  weather: WttrDay[];
}

export class WttrClient {
  constructor(private readonly opts: { timeoutMs?: number } = {}) {}

  async fetch(location: string): Promise<WttrPayload | null> {
    const url = `https://wttr.in/${encodeURIComponent(location)}?format=j1`;
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "openbrain-digest/1.0" },
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 15_000),
      });
      if (!res.ok) {
        console.warn(`wttr.in returned ${res.status} for "${location}"`);
        return null;
      }
      return await res.json() as WttrPayload;
    } catch (err) {
      console.warn(`wttr.in fetch failed for "${location}": ${err}`);
      return null;
    }
  }
}
