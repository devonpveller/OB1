/**
 * GoogleOAuth — narrow OAuth2 helper for the Gmail / Calendar APIs.
 *
 * Reads credentials.json (the OAuth client) and token.json (the user's
 * refresh + access tokens). Refreshes the access token when expired and
 * persists the new one back to disk so future runs short-circuit.
 *
 * One instance per token file. The digest container has two:
 *   - one for gmail.send  (secrets/google/openbrain-digest/token.json)
 *   - one for calendar.readonly (secrets/google/openbrain-calendar/token.json)
 *
 * Token files MUST be writable from inside the container (refresh writes
 * back). credentials.json can be :ro.
 */

interface OAuthClientFile {
  installed: { client_id: string; client_secret: string; redirect_uris: string[] };
}

interface TokenFile {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expiry_date: number;
}

export interface GoogleOAuthOptions {
  credentialsPath: string;
  tokenPath: string;
}

export class GoogleOAuth {
  constructor(private readonly opts: GoogleOAuthOptions) {}

  /** Returns a valid (refresh-if-needed) access token. Throws on misconfig. */
  async getAccessToken(): Promise<string> {
    const creds = await this.readClient();
    const token = await this.readToken();
    if (Date.now() < token.expiry_date - 60_000) return token.access_token;
    const refreshed = await this.refresh(creds, token);
    return refreshed.access_token;
  }

  private async readClient(): Promise<OAuthClientFile> {
    try {
      return JSON.parse(await Deno.readTextFile(this.opts.credentialsPath));
    } catch {
      throw new Error(
        `OAuth credentials.json missing at ${this.opts.credentialsPath}. ` +
          `Mount the OAuth client secret from secrets/google/<service>/.`,
      );
    }
  }

  private async readToken(): Promise<TokenFile> {
    try {
      return JSON.parse(await Deno.readTextFile(this.opts.tokenPath));
    } catch {
      throw new Error(
        `OAuth token.json missing at ${this.opts.tokenPath}. ` +
          `Run setup-token.ts on the host once to bootstrap (one-time browser consent).`,
      );
    }
  }

  private async refresh(creds: OAuthClientFile, token: TokenFile): Promise<TokenFile> {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: creds.installed.client_id,
        client_secret: creds.installed.client_secret,
        refresh_token: token.refresh_token,
        grant_type: "refresh_token",
      }),
    });
    const data = await res.json();
    if (data.error) {
      throw new Error(`Token refresh failed: ${data.error_description || data.error}`);
    }
    const updated: TokenFile = {
      access_token: data.access_token,
      refresh_token: token.refresh_token,
      token_type: data.token_type,
      expiry_date: Date.now() + data.expires_in * 1000,
    };
    await Deno.writeTextFile(this.opts.tokenPath, JSON.stringify(updated, null, 2));
    return updated;
  }
}
