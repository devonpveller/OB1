/**
 * WeatherSection — top-of-digest weather block.
 *
 * Reads the user's location from Open Brain (profile_field/address),
 * fetches wttr.in's structured forecast, and asks the local LLM for a
 * 1–2 sentence morning brief grounded in the same data. Returns null
 * when any step has nothing to render — the orchestrator drops null
 * sections silently.
 */

import { BrainClient } from "../clients/postgrest.ts";
import { LlmClient } from "../clients/llm.ts";
import { WttrClient, WttrPayload } from "../clients/wttr.ts";
import { Section, SectionData } from "./section.ts";

export interface WeatherPayload {
  location: string;
  currentDesc: string;
  currentTempF: string;
  feelsLikeF: string;
  humidity: string;
  windMph: string;
  windDir: string;
  todayHighF: string;
  todayLowF: string;
  tomorrowHighF: string;
  tomorrowLowF: string;
  tomorrowDesc: string;
  brief: string | null;
}

export class WeatherSection implements Section {
  readonly name = "weather";

  constructor(
    private readonly brain: BrainClient,
    private readonly wttr: WttrClient,
    private readonly llm: LlmClient,
  ) {}

  async produce(): Promise<SectionData<WeatherPayload> | null> {
    const location = await this.brain.fetchProfileField("address");
    if (!location) return null;

    const payload = await this.wttr.fetch(location);
    if (!payload) return null;

    const block = this.summarize(location, payload);
    if (!block) return null;

    block.brief = await this.brief(block);
    return { kind: "weather", payload: block };
  }

  private summarize(location: string, p: WttrPayload): WeatherPayload | null {
    const cur = p.current_condition?.[0];
    const today = p.weather?.[0];
    const tomorrow = p.weather?.[1];
    if (!cur || !today) return null;

    const tomorrowMid = tomorrow?.hourly?.find((h) => h.time === "1200") ??
      tomorrow?.hourly?.[Math.floor((tomorrow?.hourly?.length ?? 0) / 2)];

    return {
      location,
      currentDesc: cur.weatherDesc?.[0]?.value?.trim() ?? "—",
      currentTempF: cur.temp_F,
      feelsLikeF: cur.FeelsLikeF,
      humidity: cur.humidity,
      windMph: cur.windspeedMiles,
      windDir: cur.winddir16Point,
      todayHighF: today.maxtempF,
      todayLowF: today.mintempF,
      tomorrowHighF: tomorrow?.maxtempF ?? "",
      tomorrowLowF: tomorrow?.mintempF ?? "",
      tomorrowDesc: tomorrowMid?.weatherDesc?.[0]?.value?.trim() ?? "",
      brief: null,
    };
  }

  private async brief(w: WeatherPayload): Promise<string | null> {
    // Grounded summary. No tool use — the LLM doesn't search; it just
    // condenses the structured payload we already fetched. Keeps the
    // round-trip cheap and avoids hallucinated weather facts.
    const prompt =
      `Write a 1-2 sentence morning weather brief for ${w.location}. Use Fahrenheit. ` +
      `Be concrete and practical (mention if a jacket/umbrella is needed, what the day ` +
      `feels like). Plain text, no markdown, no preamble.\n\n` +
      `Current: ${w.currentDesc}, ${w.currentTempF}°F, feels like ${w.feelsLikeF}°F, ` +
      `humidity ${w.humidity}%, wind ${w.windMph}mph ${w.windDir}.\n` +
      `Today's high/low: ${w.todayHighF}°F / ${w.todayLowF}°F.\n` +
      `Tomorrow: ${w.tomorrowDesc}, high ${w.tomorrowHighF}°F low ${w.tomorrowLowF}°F.`;
    return await this.llm.chat({ prompt, maxTokens: 120, temperature: 0.3 });
  }
}
