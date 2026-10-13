/**
 * Real error bodies, as they reach the research engine through LiteLLM + llm-queue.
 *
 * Captured 2026-10-13 (mr-research-failfast round 2) from an OFFLINE rig: the
 * `llm-queue:local` image and the gateway's own LiteLLM image
 * (ghcr.io/berriai/litellm:main-stable, same image id as llm-gateway) on a private
 * `--internal` docker network, config mirroring inference/config (local-large ->
 * http://llm-queue:8080/v1, num_retries 3, request_timeout 600), and a controllable
 * fake `llama-cpp-upstream`. Nothing live was touched. The client was python httpx
 * posting `local-large:nothink` to LiteLLM, exactly the research engine's request.
 *
 * LiteLLM strips llm-queue's `{"type":"upstream_error"}` envelope: only the text of
 * llm-queue's exception survives, after "OpenAIException - llm-queue: ". A reset
 * and an upstream read timeout both arrive as an EMPTY exception text ("llm-queue: .").
 *
 * expect: "down" = the model cannot be reached (short budget, then latch + pause);
 * "overload" = reachable or ambiguous, ride it out (long budget); "fatal" = surface now.
 */
export interface GatewayBody {
  mode: string;
  how: string;
  status: number;
  body: string;
  expect: "down" | "overload" | "fatal";
}

const wrap = (cls: string, code: number, text: string) =>
  String.raw`{"error":{"message":"litellm.${cls}: ${cls}: OpenAIException - ${text}. Received Model Group=local-large:nothink\nAvailable Model Group Fallbacks=None","type":null,"param":null,"code":"${code}"}}`;

export const GATEWAY_BODIES: GatewayBody[] = [
  {
    mode: "upstream container stopped",
    how: "no llama-cpp-upstream container on the network (2026-10-13 incident)",
    status: 502, expect: "down",
    body: wrap("BadGatewayError", 502, "llm-queue: [Errno -3] Temporary failure in name resolution"),
  },
  {
    mode: "upstream refusing connections",
    how: "container up, nothing listening on :8080 (llama-swap down / restarting)",
    status: 502, expect: "down",
    body: wrap("BadGatewayError", 502, "llm-queue: All connection attempts failed"),
  },
  {
    mode: "upstream reset (RST after the request)",
    how: "fake upstream accepts, reads the request, closes with SO_LINGER 0",
    status: 502, expect: "overload",
    body: wrap("BadGatewayError", 502, "llm-queue: "),
  },
  {
    mode: "upstream read timeout",
    how: "fake upstream accepts and never answers; LLM_QUEUE_UPSTREAM_TIMEOUT_S=8",
    status: 502, expect: "overload",
    body: wrap("BadGatewayError", 502, "llm-queue: "),
  },
  {
    mode: "upstream closes without a response",
    how: "fake upstream accepts, reads the request, closes cleanly (FIN)",
    status: 502, expect: "overload",
    body: wrap("BadGatewayError", 502, "llm-queue: Server disconnected without sending a response."),
  },
  {
    mode: "llama-swap cold-load health check timeout",
    how: "fake upstream answers 500 'health check timed out after 5m0s' (llama-swap's text)",
    status: 500, expect: "fatal",
    body: wrap("InternalServerError", 500, "health check timed out after 5m0s"),
  },
  {
    mode: "llm-queue down",
    how: "no llm-queue container (LiteLLM cannot resolve it)",
    status: 500, expect: "down",
    body: wrap("InternalServerError", 500, "Connection error."),
  },
  {
    mode: "llm-queue refusing connections",
    how: "llm-queue host up, nothing listening on :8080",
    status: 500, expect: "down",
    body: wrap("InternalServerError", 500, "Connection error."),
  },
  {
    mode: "llm-queue over budget (429)",
    how: "1 slot held by a hanging request, T_INITIAL 120 s, default budget 5 s, ENFORCE_BUDGET=true",
    status: 429, expect: "overload",
    body: String.raw`{"error":{"message":"litellm.RateLimitError: RateLimitError: OpenAIException - qwen36-27b:nothink saturated: projected wait ~120s exceeds this service's 5s budget.. Received Model Group=local-large:nothink\nAvailable Model Group Fallbacks=None","type":"throttling_error","param":null,"code":"429"}}`,
  },
  {
    mode: "llm-queue over depth (429)",
    how: "1 slot held, BACKSTOP_DEPTH=1, one waiter already queued",
    status: 429, expect: "overload",
    body: String.raw`{"error":{"message":"litellm.RateLimitError: RateLimitError: OpenAIException - qwen36-27b:nothink saturated: 1 requests already waiting (backstop 1).. Received Model Group=local-large:nothink\nAvailable Model Group Fallbacks=None","type":"throttling_error","param":null,"code":"429"}}`,
  },
];

/** LiteLLM itself down: no HTTP answer at all. The python client saw
 *  `ConnectError: [Errno -3] Temporary failure in name resolution`; the engine's
 *  Deno fetch throws a TypeError ("error sending request ... dns error" /
 *  "Connection refused") - classified DOWN in llm.ts as a network failure. */
export const LITELLM_DOWN_CLIENT_ERROR = "ConnectError: [Errno -3] Temporary failure in name resolution";
