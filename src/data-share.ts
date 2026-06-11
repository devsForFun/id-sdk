import type { DfidClientConfig } from './types.js';
import { projectHeaders } from './hmac.js';

// App-to-app data sharing (A ↔ B). A user grants a target app permission to
// read scoped data the source app holds. The flow:
//   1. The TARGET app sends the user to the hub consent screen
//      (`authorize(...)` builds that URL).
//   2. On approval the hub redirects back to `redirectUri?code=…&state=…`.
//   3. The TARGET app exchanges the code for opaque tokens
//      (`exchangeToken(...)` → POST /api/oauth/data-share/token).
//   4. When the SOURCE app (the resource server holding the data) receives a
//      bearer token, it verifies it via `introspect(token)` (HMAC) before
//      serving data.

export type ExchangeTokenResult = {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    token_type: string;
};

export type IntrospectResult =
    | { active: false }
    | {
          active: true;
          sub: string;
          scope: string;
          source_project_id: string;
          target_project_id: string;
          exp: number;
      };

export type PublicProfile = {
    username?: string;
    display_name?: string;
    avatar_url?: string;
    email?: string;
};

export function createDataShare(config: DfidClientConfig) {
    return {
        /**
         * Build the URL to send the user to the hub's data-share consent screen.
         * The TARGET app calls this; on approval the hub redirects the user to
         * `redirectUri?code=<one-time-code>&state=<state>`, where the code is
         * exchanged via `exchangeToken`. `scopes` must be a subset of the target
         * client's allowed_data_share_scopes (enforced on the hub).
         */
        authorize(opts: {
            sourceClientId: string;
            targetClientId: string;
            scopes: string[];
            redirectUri: string;
            state?: string;
        }): string {
            const url = new URL('/data-share/authorize', config.url);
            url.searchParams.set('source_client_id', opts.sourceClientId);
            url.searchParams.set('target_client_id', opts.targetClientId);
            url.searchParams.set('scope', opts.scopes.join(' '));
            url.searchParams.set('redirect_uri', opts.redirectUri);
            if (opts.state) url.searchParams.set('state', opts.state);
            return url.toString();
        },

        /**
         * Exchange a one-time authorization code (or a refresh token) for an
         * opaque access + refresh token pair. POST /api/oauth/data-share/token.
         * Not HMAC-authed — the one-time code / refresh token is the credential.
         */
        async exchangeToken(
            opts:
                | { grantType: 'authorization_code'; code: string; targetClientId: string }
                | { grantType: 'refresh_token'; refreshToken: string; targetClientId: string },
        ): Promise<ExchangeTokenResult> {
            const body =
                opts.grantType === 'authorization_code'
                    ? {
                          grant_type: 'authorization_code',
                          code: opts.code,
                          target_client_id: opts.targetClientId,
                      }
                    : {
                          grant_type: 'refresh_token',
                          refresh_token: opts.refreshToken,
                          target_client_id: opts.targetClientId,
                      };
            const res = await fetch(`${config.url}/api/oauth/data-share/token`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (!res.ok) {
                const err = (await res.json().catch(() => null)) as { error?: string } | null;
                throw new Error(err?.error ?? `data-share.exchangeToken failed: ${res.status}`);
            }
            return (await res.json()) as ExchangeTokenResult;
        },

        /**
         * RFC 7662 token introspection. The resource server (the project the
         * token was issued FOR) verifies a bearer token before serving data.
         * Project-HMAC authed over the raw JSON body. Returns `{ active: false }`
         * on any failure (expired, revoked, or introspected by the wrong project)
         * without revealing which check failed.
         */
        async introspect(token: string): Promise<IntrospectResult> {
            const body = JSON.stringify({ token });
            const headers = {
                'Content-Type': 'application/json',
                ...projectHeaders(config.projectId, config.hmacSecret, body),
            };
            const res = await fetch(`${config.url}/api/oauth/data-share/introspect`, {
                method: 'POST',
                headers,
                body,
            });
            // The endpoint returns 200 { active: false } for soft failures and
            // 429 for rate limits; treat a non-OK as inactive rather than throw.
            if (!res.ok) {
                return { active: false };
            }
            return (await res.json()) as IntrospectResult;
        },

        profile: {
            /**
             * Fetch a user's world-readable public profile card by username.
             * GET /api/profile/public/:username — UNAUTHENTICATED, gated entirely
             * by the user's per-field visibility. Returns only the fields the user
             * made public; throws on 404 (no such username or nothing public).
             */
            async getPublic(username: string): Promise<PublicProfile> {
                const res = await fetch(
                    `${config.url}/api/profile/public/${encodeURIComponent(username)}`,
                );
                if (!res.ok) {
                    const err = (await res.json().catch(() => null)) as { error?: string } | null;
                    throw new Error(err?.error ?? `data-share.profile.getPublic failed: ${res.status}`);
                }
                return (await res.json()) as PublicProfile;
            },
        },
    };
}
