#!/usr/bin/env -S deno run --allow-net --allow-read --allow-write --allow-env

/**
 * One-time OAuth bootstrap for the calendar.readonly scope.
 *
 * Run this on the HOST (not in the container). It will:
 *   1. open the Google consent screen in your default browser
 *   2. capture the redirect on http://127.0.0.1:8765
 *   3. exchange the code for a token with the calendar.readonly scope
 *   4. write calendar-token.json next to this script
 *
 * Then move the file to secrets/google/openbrain-digest/calendar-token.json
 * so the digest container can mount it (same pattern as the gmail.send
 * token from setup-token.ts).
 *
 * Prereq: credentials.json next to this file (the same OAuth client used
 * by gmail-pull and the digest's gmail.send). The OAuth consent screen
 * for that client must include calendar.readonly under Data Access.
 *
 * Usage (PowerShell, from the daily-digest recipe directory):
 *   deno run --allow-net --allow-read --allow-write --allow-env setup-calendar-token.ts
 */

// On Windows, URL.pathname yields an unreadable "/D:/Open%20WebUI/..." form
// (leading slash + percent-encoded spaces). Decode and strip the slash so the
// path resolves on both Windows and POSIX.
const SCRIPT_DIR = decodeURIComponent(new URL(".", import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, "$1");
const CREDENTIALS_PATH = `${SCRIPT_DIR}credentials.json`;
const TOKEN_PATH = `${SCRIPT_DIR}calendar-token.json`;
const SCOPES = ["https://www.googleapis.com/auth/calendar.readonly"];
const REDIRECT_PORT = 8765;
const REDIRECT_URI = `http://127.0.0.1:${REDIRECT_PORT}`;
const FLOW_TIMEOUT_MS = 5 * 60 * 1000;

interface OAuthCredentials {
  installed: { client_id: string; client_secret: string; redirect_uris: string[] };
}

async function main() {
  let creds: OAuthCredentials;
  try {
    creds = JSON.parse(await Deno.readTextFile(CREDENTIALS_PATH));
  } catch {
    console.error(
      `\nNo credentials.json at ${CREDENTIALS_PATH}.\n` +
        `Copy or symlink your OAuth client secret here, then re-run.\n`,
    );
    Deno.exit(1);
  }

  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", creds.installed.client_id);
  authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", SCOPES.join(" "));
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");

  console.log(
    `\nOpen this URL in your browser to grant calendar.readonly:\n  ${authUrl}\n` +
      `\nWaiting for the redirect on ${REDIRECT_URI} (5 min timeout)...\n`,
  );

  const code = await new Promise<string>((resolve, reject) => {
    const ac = new AbortController();
    const timer = setTimeout(() => {
      ac.abort();
      reject(new Error("OAuth flow timed out — no redirect received."));
    }, FLOW_TIMEOUT_MS);

    Deno.serve(
      { port: REDIRECT_PORT, signal: ac.signal, onListen: () => {} },
      (req) => {
        const u = new URL(req.url);
        const c = u.searchParams.get("code");
        const err = u.searchParams.get("error");
        if (err) {
          clearTimeout(timer);
          ac.abort();
          reject(new Error(`OAuth error: ${err}`));
          return new Response(`OAuth error: ${err}`, { status: 400 });
        }
        if (c) {
          clearTimeout(timer);
          queueMicrotask(() => {
            ac.abort();
            resolve(c);
          });
          return new Response(
            "Calendar token captured. You can close this tab and return to the terminal.",
            { status: 200, headers: { "Content-Type": "text/plain" } },
          );
        }
        return new Response("Missing code parameter", { status: 400 });
      },
    );
  });

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: creds.installed.client_id,
      client_secret: creds.installed.client_secret,
      redirect_uri: REDIRECT_URI,
      grant_type: "authorization_code",
    }),
  });
  const data = await res.json();
  if (data.error) {
    throw new Error(`Token exchange failed: ${data.error_description || data.error}`);
  }

  const token = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    token_type: data.token_type,
    expiry_date: Date.now() + data.expires_in * 1000,
  };
  await Deno.writeTextFile(TOKEN_PATH, JSON.stringify(token, null, 2));
  console.log(`\nCalendar token written to ${TOKEN_PATH}.`);
  console.log(
    `Move it to secrets/google/openbrain-digest/calendar-token.json before the next digest run.\n`,
  );
}

main();
