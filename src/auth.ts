import type { DfidClientConfig, DfidSession, TokenResponse } from './types.js';
import { decodeJwt } from './jwt.js';
import { DfidOAuthError } from './errors.js';

// Auth surface — these helpers do not need the HMAC secret. They handle the
// user-facing OAuth flow against devsforfun ID's authorization endpoints.

function requireOauthClientId(config: DfidClientConfig): string {
    if (!config.oauthClientId) {
        throw new Error(
            'Missing DEVSFORFUN_ID_OAUTH_CLIENT_ID — set the env var (or pass `oauthClientId` to createDfidClient) to use auth.signIn / auth.handleCallback.',
        );
    }
    return config.oauthClientId;
}

const DEFAULT_TIMEOUT_MS = 10_000;

// Transient-retry schedule for refreshSession. The hub rotates refresh tokens
// with a short server-side reuse-grace window (~10s): re-presenting the SAME
// refresh token quickly after a lost response is safe — if the first attempt
// actually succeeded server-side, the grace window returns the same token
// family instead of revoking it. The total worst-case elapsed time across
// retries must stay well inside that window, hence the hard elapsed budget.
const RETRY_BACKOFF_MS = [250, 750];
const MAX_RETRY_ELAPSED_MS = 6_000;

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// One POST to the hub token endpoint with timeout + caller-abort support and
// RFC 6749 error mapping. No retry here — retry policy belongs to the caller
// because it differs per grant (refresh: bounded retry; code exchange: never).
async function postTokenEndpoint(
    config: DfidClientConfig,
    params: URLSearchParams,
    opts: { signal?: AbortSignal; timeoutMs: number },
): Promise<TokenResponse> {
    if (opts.signal?.aborted) {
        throw opts.signal.reason instanceof Error
            ? opts.signal.reason
            : new DfidOAuthError({
                  code: 'network_error',
                  status: null,
                  description: 'Request aborted before it started.',
              });
    }

    const controller = new AbortController();
    const onCallerAbort = () => controller.abort(opts.signal?.reason);
    opts.signal?.addEventListener('abort', onCallerAbort, { once: true });
    const timer = setTimeout(
        () =>
            controller.abort(
                new DfidOAuthError({
                    code: 'network_error',
                    status: null,
                    description: `Token request timed out after ${opts.timeoutMs}ms.`,
                }),
            ),
        opts.timeoutMs,
    );

    // Rejects when the controller aborts. Raced against the BODY reads too —
    // fetch resolves at headers, so a stalled/never-ending body would
    // otherwise hang past both timeoutMs and the caller's signal.
    const aborted = new Promise<never>((_, reject) => {
        controller.signal.addEventListener('abort', () => reject(controller.signal.reason), {
            once: true,
        });
    });
    void aborted.catch(() => {}); // always-observed; races below still receive the rejection

    // Body-read helper: null for malformed-but-complete bodies; abort/timeout
    // reasons propagate instead of being swallowed into "malformed".
    const readJson = async (res: Response): Promise<unknown> => {
        try {
            return await Promise.race([res.json(), aborted]);
        } catch (e) {
            if (e instanceof DfidOAuthError) throw e; // our timeout reason
            if (opts.signal?.aborted) throw e; // caller abort propagates as-is
            return null;
        }
    };

    try {
        let res: Response;
        try {
            res = await Promise.race([
                fetch(`${config.url}/api/oauth/token`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: params.toString(),
                    cache: 'no-store',
                    signal: controller.signal,
                }),
                aborted,
            ]);
        } catch (e) {
            // Our timeout abort carries a DfidOAuthError as the abort reason.
            if (e instanceof DfidOAuthError) throw e;
            // Caller-initiated aborts propagate as-is (AbortError semantics).
            if (opts.signal?.aborted) throw e;
            throw new DfidOAuthError({
                code: 'network_error',
                status: null,
                description: e instanceof Error ? e.message : String(e),
            });
        }

        if (!res.ok) {
            const body = (await readJson(res)) as {
                error?: string;
                error_description?: string;
            } | null;
            const retryAfterHeader = res.headers.get('retry-after');
            const retryAfterSeconds = retryAfterHeader
                ? Number(retryAfterHeader) || undefined
                : undefined;
            // Precedence: transport semantics (429/5xx) over the body's OAuth
            // code — a 5xx is retryable no matter what the body claims.
            const code =
                res.status === 429
                    ? 'rate_limited'
                    : res.status >= 500
                      ? 'server_error'
                      : (body?.error ?? 'invalid_request');
            throw new DfidOAuthError({
                code,
                status: res.status,
                description: body?.error_description,
                retryAfterSeconds,
            });
        }

        const tokens = (await readJson(res)) as TokenResponse | null;
        if (
            !tokens ||
            typeof tokens.access_token !== 'string' ||
            tokens.access_token.length === 0
        ) {
            throw new DfidOAuthError({
                code: 'server_error',
                status: res.status,
                description: 'Token endpoint returned a malformed success body.',
            });
        }
        return tokens;
    } finally {
        clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onCallerAbort);
    }
}

export function createAuth(config: DfidClientConfig) {
    // Single-flight refresh dedupe, keyed by refresh token. Concurrent
    // refreshSession calls with the same token (parallel middleware
    // invocations, prefetches) share one network request — combined with the
    // hub's reuse-grace window this makes refresh races safe in-process AND
    // across serverless instances.
    const inflightRefreshes = new Map<string, Promise<TokenResponse>>();

    return {
        // Build the redirect URL to start the OAuth code flow. This points
        // at the hub's /oauth/authorize, which forwards vanilla OAuth params
        // (those without an authorization_id) to Supabase's OAuth server —
        // Supabase validates and bounces back to the consent screen. See
        // app/(auth)/oauth/authorize/page.tsx on the hub for the wrapper.
        signIn(opts: {
            redirectUri: string;
            scopes?: string[];
            state?: string;
            codeChallenge?: string;
        }): string {
            const clientId = requireOauthClientId(config);
            const url = new URL('/oauth/authorize', config.url);
            url.searchParams.set('response_type', 'code');
            url.searchParams.set('client_id', clientId);
            url.searchParams.set('redirect_uri', opts.redirectUri);
            url.searchParams.set('scope', (opts.scopes ?? ['openid', 'profile', 'email']).join(' '));
            if (opts.state) url.searchParams.set('state', opts.state);
            if (opts.codeChallenge) {
                url.searchParams.set('code_challenge', opts.codeChallenge);
                url.searchParams.set('code_challenge_method', 'S256');
            }
            return url.toString();
        },

        // Build the redirect URL for sign-out. Satellite handles its own
        // session teardown separately (clearing cookies, calling Supabase
        // signOut, etc).
        signOut(opts: { redirectUri?: string } = {}): string {
            const url = new URL('/logout', config.url);
            if (opts.redirectUri) url.searchParams.set('next', opts.redirectUri);
            return url.toString();
        },

        // Exchange the OAuth code for tokens (server-side; needs PKCE verifier).
        // No retry: authorization codes are single-use — a retried exchange
        // whose first attempt reached the server can never succeed.
        async handleCallback(opts: {
            code: string;
            codeVerifier: string;
            redirectUri: string;
            signal?: AbortSignal;
            timeoutMs?: number;
        }): Promise<TokenResponse> {
            const clientId = requireOauthClientId(config);
            const params = new URLSearchParams({
                grant_type: 'authorization_code',
                code: opts.code,
                code_verifier: opts.codeVerifier,
                redirect_uri: opts.redirectUri,
                client_id: clientId,
            });
            // Confidential clients must send the client_secret.
            // Public (PKCE-only) clients omit it.
            if (config.oauthClientSecret) {
                params.set('client_secret', config.oauthClientSecret);
            }
            return postTokenEndpoint(config, params, {
                signal: opts.signal,
                timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            });
        },

        /**
         * Exchange a refresh token for a fresh token set
         * (`grant_type=refresh_token`).
         *
         * Rotation: the hub returns a NEW refresh_token on every call and
         * invalidates the old one after a short reuse-grace window. ALWAYS
         * persist the returned refresh_token before using the new access
         * token; reusing a stale refresh token beyond the grace window
         * revokes the whole session family.
         *
         * Failure semantics: throws DfidOAuthError. `requiresReauth` means
         * the grant is dead — clear the session and start sign-in again.
         * `isTransient` failures (network, 5xx, rate limit) are retried
         * automatically with short backoff, bounded well inside the
         * rotation-grace window; pass `retries: 0` to disable.
         *
         * Concurrency: calls with the same refresh token share one in-flight
         * request by default (`dedupe: false` opts out — note the first
         * caller's signal/timeout then governs the shared request).
         */
        refreshSession(opts: {
            refreshToken: string;
            signal?: AbortSignal;
            timeoutMs?: number;
            retries?: number;
            dedupe?: boolean;
        }): Promise<TokenResponse> {
            if (!opts.refreshToken) {
                return Promise.reject(
                    new DfidOAuthError({
                        code: 'invalid_request',
                        status: null,
                        description: 'refreshToken is required.',
                    }),
                );
            }

            const dedupe = opts.dedupe !== false;
            if (dedupe) {
                const existing = inflightRefreshes.get(opts.refreshToken);
                if (existing) return existing;
            }

            const run = (async (): Promise<TokenResponse> => {
                // Inside the async closure so a missing client id REJECTS
                // (consistent with every other failure) instead of throwing
                // synchronously.
                const clientId = requireOauthClientId(config);
                const params = new URLSearchParams({
                    grant_type: 'refresh_token',
                    refresh_token: opts.refreshToken,
                    client_id: clientId,
                });
                if (config.oauthClientSecret) {
                    params.set('client_secret', config.oauthClientSecret);
                }

                const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
                // Clamp: negative/NaN retries must not skip the loop entirely
                // (which would reject with a bare `undefined`).
                const extraRetries = Math.max(
                    0,
                    Math.floor(opts.retries ?? RETRY_BACKOFF_MS.length) || 0,
                );
                const maxAttempts = 1 + extraRetries;
                const startedAt = Date.now();
                let lastError: unknown;

                for (let attempt = 0; attempt < maxAttempts; attempt++) {
                    if (attempt > 0) {
                        const backoff =
                            RETRY_BACKOFF_MS[Math.min(attempt - 1, RETRY_BACKOFF_MS.length - 1)]!;
                        const prev = lastError instanceof DfidOAuthError ? lastError : null;
                        const waitMs =
                            prev?.code === 'rate_limited' && prev.retryAfterSeconds != null
                                ? Math.max(backoff, prev.retryAfterSeconds * 1000)
                                : backoff;
                        // Never retry past the elapsed budget — a late retry
                        // could land outside the rotation-grace window and
                        // revoke the session family instead of recovering it.
                        if (Date.now() - startedAt + waitMs > MAX_RETRY_ELAPSED_MS) break;
                        await sleep(waitMs);
                    }
                    try {
                        return await postTokenEndpoint(config, params, {
                            signal: opts.signal,
                            timeoutMs,
                        });
                    } catch (e) {
                        lastError = e;
                        const transient = e instanceof DfidOAuthError && e.isTransient;
                        if (!transient || opts.signal?.aborted) throw e;
                    }
                }
                throw lastError;
            })();

            if (dedupe) {
                inflightRefreshes.set(opts.refreshToken, run);
                void run
                    .catch(() => {})
                    .finally(() => inflightRefreshes.delete(opts.refreshToken));
            }
            return run;
        },

        /**
         * True when the access token is missing, undecodable, has no `exp`,
         * or expires within `skewSeconds` (default 60) — i.e. it is time to
         * call refreshSession. Decode-only; no signature verification.
         */
        shouldRefresh(
            accessToken: string | null | undefined,
            opts: { skewSeconds?: number } = {},
        ): boolean {
            if (!accessToken) return true;
            const skew = opts.skewSeconds ?? 60;
            try {
                const session = decodeJwt(accessToken);
                if (typeof session.exp !== 'number') return true;
                return session.exp - Math.floor(Date.now() / 1000) <= skew;
            } catch {
                return true;
            }
        },

        // Decode a JWT into a session object. No signature verification —
        // callers that need that should use Supabase SSR or fetch the JWKS.
        getSession(accessToken: string): DfidSession {
            return decodeJwt(accessToken);
        },

        // Alias — semantically returns the user portion of the session.
        getUser(accessToken: string): DfidSession {
            return decodeJwt(accessToken);
        },
    };
}
