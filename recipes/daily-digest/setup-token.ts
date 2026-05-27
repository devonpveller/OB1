#!/usr/bin/env -S deno run --allow-net --allow-read --allow-write --allow-env

/**
 * One-time OAuth bootstrap for the daily digest.
 *
 * Run this on the HOST (not in the container). It will:
 *   1. open the Google consent screen in your default browser
 *   2. capture the redirect on http://127.0.0.1:8765
 *   3. exchange the code for tokens with the gmail.send scope
 *   4. write token.json next to this script
 *
 * After this completes once, the openbrain-digest container can run
 * unattended — it only needs to refresh the access token (the refresh
 * token persists in token.json).
 *
 * Prereq: credentials.json next to this file (the same OAuth client used
 * by gmail-pull — you can copy or symlink secrets/google/open-brain-email/
 * client_secret_*.json to ./credentials.json). The OAuth consent screen
 * for that client must include the gmail.send scope.
 *
 * Usage (PowerShell, from the daily-digest recipe directory):
 *   deno run --allow-net --allow-read --allow-write --allow-env setup-token.ts
 */

const SCRIPT_DIR = new URL(".", import.meta.url).pathname;
const CREDENTIALS_PATH = `${SCRIPT_DIR}credentials.json`;
const TOKEN_PATH = `${SCRIPT_DIR}token.json`;
const SCOPES = ["https://www.googleapis.com/auth/gmail.send"];
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
    `\nOpen this URL in your browser to grant gmail.send:\n  ${authUrl}\n` +
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
          // Defer abort until the response has been written.
          queueMicrotask(() => {
            ac.abort();
            resolve(c);
          });
          return new Response(
            "Token captured. You can close this tab and return to the terminal.",
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
  console.log(`\nToken written to ${TOKEN_PATH}.`);
  console.log(
    `Move it to secrets/google/openbrain-digest/token.json before the container runs.\n`,
  );
}

main();
