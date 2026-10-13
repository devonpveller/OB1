/** The research_jobs.error body of job 37b3e59f (2026-10-13, read-only SELECT on
 *  the live DB), minus its "chat 502: " prefix: what LiteLLM returned while
 *  llm-queue could not resolve the stopped llama-cpp-upstream container. The
 *  `\\n` is a JSON escape (backslash + n) inside the body, exactly as served. */
export const REAL_DOWN_502 =
  String.raw`{"error":{"message":"litellm.BadGatewayError: BadGatewayError: OpenAIException - llm-queue: [Errno -3] Temporary failure in name resolution. Received Model Group=local-large\nAvailable Model Group Fallbacks=None","type":null,"param":null,"code":"502"}}`;
