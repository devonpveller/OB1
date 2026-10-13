/**
 * Did a failed request leave the machine? (mr-routine-outage round 2)
 *
 * Send-once needs the difference between DEFINITELY NOT SENT (safe to retry)
 * and MAYBE SENT (retrying could duplicate). A fetch that failed while
 * CONNECTING never delivered a byte of the request body: DNS lookup, connection
 * refused, no route, TLS handshake / certificate. Anything else that rejects -
 * a timeout, a reset or a closed connection while waiting for the answer - may
 * have reached the server.
 *
 * Deno's messages for the connect phase (2.x, hyper client):
 *   "error sending request for url (...): client error (Connect): tcp connect error: Connection refused (os error 111)"
 *   "error sending request for url (...): client error (Connect): dns error: failed to lookup address information: ..."
 *   "... client error (Connect): invalid peer certificate: ..." / "... tls handshake eof"
 * Matching is deliberately on the connect-phase wording only; an unknown
 * message stays MAYBE SENT (at most once wins).
 */

const CONNECT_PHASE =
  /client error \(Connect\)|tcp connect error|dns error|failed to lookup address|name or service not known|no such host is known|connection refused|actively refused|no route to host|network is unreachable|host is unreachable|invalid peer certificate|certificate verify|tls handshake|handshake failure/i;

/** true = the request certainly never reached the server. */
export function failedBeforeSend(e: unknown): boolean {
  const err = e as Error | undefined;
  if (!err) return false;
  if (err.name === "TimeoutError" || err.name === "AbortError") return false;
  const msg = `${err.message ?? ""} ${String((err as { cause?: unknown }).cause ?? "")}`;
  return CONNECT_PHASE.test(msg);
}
