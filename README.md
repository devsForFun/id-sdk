# @devsforfun/id-sdk

Typed Node SDK for devsforfun ID — "Sign in with devsforfun ID" plus the satellite integration surface: profile, entitlements, per-app sessions, app-to-app data-sharing, and webhooks, in a single typed client.

> **Public on npm as of 0.6.0.** Earlier versions shipped only via GitHub Packages (restricted). No registry mapping or PAT is needed anymore — it installs from the public registry like any other package.

## Install

```
npm i @devsforfun/id-sdk
```

That's it — no `.npmrc` scope mapping or `GITHUB_TOKEN` required. (Pre-0.6.0 GitHub-Packages instructions are obsolete; drop the `@devsforfun:registry=…` line from old `.npmrc` files.)

## Configure

The SDK reads four env vars by default; you can also pass them explicitly to `createDfidClient`.

```
DEVSFORFUN_ID_URL=https://devsforfun.app
DEVSFORFUN_ID_PROJECT_ID=<projects.id (uuid) — used for HMAC layer>
DEVSFORFUN_ID_HMAC_SECRET=<projects.signing_secret — shown once>
DEVSFORFUN_ID_OAUTH_CLIENT_ID=<oauth_clients.client_id (dff_…) — used by auth.signIn / handleCallback>
```

All four come from the same screen when you create a project in the [developer portal](https://devsforfun.app/developer) (Projects → New).

The HMAC secret is sensitive — never expose it to a browser bundle. Same goes for the OAuth client secret (used by `/api/oauth/token` server-side, not exposed in the SDK surface).

`DEVSFORFUN_ID_OAUTH_CLIENT_ID` is only required if you call `auth.signIn` / `auth.handleCallback`. HMAC-only callers (webhooks, entitlements, sessions lookups) don't need it.

## Use

```ts
import { createDfidClient } from '@devsforfun/id-sdk';

const dfid = createDfidClient();

// auth (browser/server)
const signInUrl = dfid.auth.signIn({ redirectUri: 'https://my-app.com/callback' });
const tokens = await dfid.auth.handleCallback({ code, codeVerifier, redirectUri });
const session = dfid.auth.getSession(tokens.access_token);

// profile (Bearer for /me; HMAC for /:userId)
const me = await dfid.profile.getMe(tokens.access_token);
const other = await dfid.profile.getUser(someUserId);

// entitlements — HMAC PULL (source of truth, ~60s in-process cache)
const { entitled, entitlement } = await dfid.entitlements.pull(userId, appId);
if (entitled) { /* unlock — entitlement.feature_code / expires_at available */ }
// bust the cache from a webhook handler on entitlement.updated / .revoked:
dfid.entitlements.invalidate(userId, appId);

// entitlements — DEPRECATED JWT-claim reads (zero network, but the claim is
// being retired — migrate to pull()):
const ents = dfid.entitlements.get(tokens.access_token); // @deprecated
if (dfid.entitlements.check(ents, 'my-app:pro')) { /* unlock pro */ }

// app-to-app data sharing
// 1) send the user to the hub consent screen (the TARGET app calls this):
const consentUrl = dfid.dataShare.authorize({
    sourceClientId,
    targetClientId,
    scopes: ['profile:read'],
    redirectUri: 'https://my-app.com/data-share/callback',
    state,
});
// 2) exchange the returned code for opaque tokens:
const dsTokens = await dfid.dataShare.exchangeToken({
    grantType: 'authorization_code',
    code,
    targetClientId,
});
// 3) the resource server verifies an inbound bearer token before serving data:
const result = await dfid.dataShare.introspect(bearerToken);
if (result.active) { /* serve data for result.sub within result.scope */ }
// public profile card (unauthenticated, gated by the user's field visibility):
const card = await dfid.dataShare.profile.getPublic('someusername');

// sessions (server-only, HMAC) — "your sessions in this app" panels.
// Only sessions/events attributable to YOUR app are returned (attribution is
// GoTrue's native oauth_client_id, so cross-app isolation is structural).
const { sessions, recent_events } = await dfid.sessions.list({ userId });
// "sign out this device" — revoking a hub session or another app's session 404s:
const { revoked } = await dfid.sessions.revoke({ sessionId: sessions[0].id });

// webhooks (server-only, HMAC)
const sub = await dfid.webhooks.subscribe(userId, 'user.erasure_requested', 'https://my-app.com/webhooks/dfid');
await dfid.webhooks.publishEvent('my-app.post.published', userId, { post_id: 'abc' });

// verifying an inbound webhook
const valid = dfid.webhooks.verifySignature(
    rawBody,
    {
        signature: req.headers.get('x-webhook-signature'),
        timestamp: req.headers.get('x-webhook-timestamp'),
    },
    sub.signing_secret,
);
```

## Surface

| Namespace | Methods |
|---|---|
| `auth` | `signIn(opts)`, `signOut(opts)`, `handleCallback(opts)`, `refreshSession(opts)`, `shouldRefresh(token, opts?)`, `getSession(token)`, `getUser(token)` |
| `profile` | `getMe(token)`, `updateMe(token, data)`, `uploadAvatar(token, file)`, `getUser(userId)` |
| `entitlements` | `pull(userId, appId)`, `invalidate(userId, appId)`, **deprecated:** `get(token)`, `check(source, ent)`, `forApp(token, slug)` |
| `dataShare` | `authorize(opts)`, `exchangeToken(opts)`, `introspect(token)` |
| `dataShare.profile` | `getPublic(username)` |
| `sessions` | `list({ userId })`, `revoke({ sessionId })` |
| `webhooks` | `subscribe`, `unsubscribe`, `publishEvent`, `verifySignature` |

> **Deprecated:** `entitlements.get` / `check` / `forApp` read the legacy JWT entitlements claim. That claim is being retired — prefer `entitlements.pull(userId, appId)`, which reads the live entitlement from the hub over the HMAC channel (with a short in-process cache you bust via `invalidate`).

> **Looking for the Google proxy, payments, or the agents plane?** Those surfaces are reserved for first-party (devsforfun-owned) apps — the hub rejects other projects with HTTP 403 regardless of a valid signature — and live in the internal-only `@devsforfun/id-sdk-internal` package, which is not published to npm.

## Token refresh

Access tokens are short-lived (~1h). `handleCallback` also returns a
`refresh_token`; store it server-side (httpOnly cookie or session store) and
exchange it when the access token nears expiry:

```ts
if (dfid.auth.shouldRefresh(accessToken)) {
    try {
        const tokens = await dfid.auth.refreshSession({ refreshToken });
        // ROTATION: persist tokens.refresh_token — the old one is now dead.
        saveSession(tokens.access_token, tokens.refresh_token);
    } catch (e) {
        if (e instanceof DfidOAuthError && e.requiresReauth) {
            clearSession(); // grant is dead — send the user through sign-in
        } else {
            // transient (network/5xx/rate limit) — already retried internally;
            // keep the current session and try again on the next request
        }
    }
}
```

Semantics worth knowing:

- **Rotation** — every refresh returns a NEW `refresh_token` and invalidates
  the previous one after a short server-side grace window. Always persist the
  newest one. Reusing a stale refresh token beyond the window revokes the
  whole session family (the user must sign in again).
- **Concurrency** — concurrent `refreshSession` calls with the same token
  share one in-flight request per client instance, and the server-side grace
  window absorbs cross-instance races (parallel serverless invocations).
- **Retries** — transient failures (network, 5xx, 429) retry automatically
  with short backoff, bounded to stay inside the rotation-grace window. OAuth
  protocol errors never retry. Disable with `retries: 0`; cancel via
  `signal`; per-attempt `timeoutMs` defaults to 10s.
- **Errors** — failures throw `DfidOAuthError` with `code`
  (`invalid_grant`, `rate_limited`, `network_error`, …), `status`,
  `description`, `retryAfterSeconds`, plus `requiresReauth` / `isTransient`
  getters. `handleCallback` throws the same class.

## Accessing your own Supabase with RLS (token re-minting)

The SDK gives you the **verified hub identity** (`auth.getUser(token)` / the JWT's `sub`). It does **not** create your Supabase client — and you should **not** forward the hub token to your own Supabase's PostgREST. Supabase enforces signing-key `kid` uniqueness across an organization, so you cannot import the hub's signing key into your project (it 409s), which means your PostgREST has no way to verify a hub-issued token directly.

Canonical pattern: give your satellite its **own** Supabase signing key, then in server code verify the hub JWT (`jose` against the hub JWKS) and **re-mint** a short-lived token signed with your own key, carrying the same `sub` and `role: authenticated`. Send that to PostgREST — `auth.uid()` resolves to the hub `sub` and your RLS works unchanged.

The full walkthrough lives in the developer portal docs at `https://devsforfun.app/developer`.

## Engines

Node.js ≥ 18. The SDK uses `node:crypto` for HMAC, so it does not run in a browser bundle — only Next.js server components, route handlers, or backend code.

## Build

```
npm run build      # tsup → dist/ (ESM + CJS + d.ts)
npm run typecheck
```

## Versioning

Strict semver. Breaking changes bump the major. Pre-1.0 (v0.x), minor bumps may include breaking changes; track the changelog in this README.

## Changelog

- **0.11.1** — **Docs sync, no code change.** Regenerated
  `src/generated/openapi-types.ts` from the hub's current public OpenAPI
  spec — `GET /api/profile/me` was missing its `description` (added on the
  hub side without a matching refresh here). No behavioral change.
- **0.11.0** — **Additive (OAuth state helpers).**
  - `auth.buildState({ csrf, returnTo? })` — encodes a CSRF nonce + optional
    post-auth return path into the base64url-JSON `state` param `auth.signIn`
    expects, so satellites don't hand-roll the encoding.
  - `auth.parseState(state)` — decodes it back to `{ csrf, returnTo }`, or
    `null` if malformed/tampered; compare `csrf` against your stored nonce
    before honoring `returnTo`.
- **0.10.0** — **Additive (token refresh).**
  - `auth.refreshSession({ refreshToken, signal?, timeoutMs?, retries?, dedupe? })`
    — exchanges a refresh token at `POST /api/oauth/token`
    (`grant_type=refresh_token`, form-encoded, `client_id` +
    `client_secret` for confidential clients). Rotation-aware: single-flight
    dedupe per refresh token, automatic bounded retry on transient failures
    (kept inside the server's rotation reuse-grace window), per-attempt
    timeout + AbortSignal support.
  - `auth.shouldRefresh(accessToken, { skewSeconds? })` — decode-only expiry
    check (default 60s skew) for proactive refresh.
  - New exported type `TokenResponse` (now also the `handleCallback` return
    type — same shape as before, now named) and new error class
    `DfidOAuthError` (`code`, `status`, `description`, `retryAfterSeconds`,
    `requiresReauth`, `isTransient`).
  - Errors enriched: `handleCallback` now throws `DfidOAuthError` instead of
    a plain `Error`, and surfaces the hub's `error_description` in the
    message (`'<code>: <description>'`; previously just `'<code>'`). It also
    gains optional `signal` / `timeoutMs`. Code exchanges are never retried
    (authorization codes are single-use).
- **0.9.0** — **Breaking (pre-publish restructure).** The package now contains
  ONLY the third-party-granted integration surface: `auth`, `profile`,
  `entitlements`, `webhooks`, `dataShare`, `sessions`. First-party-only
  surfaces (Google proxy, payments, agents plane, billing, calendar watch)
  moved to the internal-only `@devsforfun/id-sdk-internal` package — if you
  are a devsforfun first-party app, switch `createDfidClient` →
  `createDfidInternalClient` from that package (same config, superset
  surface). This is the version line that ships as the FIRST public npm
  release; nothing earlier was ever published to npmjs.
- **0.8.0** — **Additive.** New `sessions` namespace — per-app session list +
  revoke (`dfid.sessions.list` / `dfid.sessions.revoke`). `sessions.list({
  userId })` (GET `/api/sessions?user_id=…`, signed payload is the literal
  user_id) returns `{ sessions, recent_events }` — only sessions and auth
  events attributable to the calling project (attribution is structural),
  gated by the user's connected-apps consent. `sessions.revoke({ sessionId })`
  (DELETE `/api/sessions/:id`, signed payload is the literal session id) signs
  out one device. Server-only, project-HMAC authed. New exported types:
  `AppSession`, `AppAuthEvent`, `SessionsListResult`.
- **0.7.0** — internal-surface additions (now in `@devsforfun/id-sdk-internal`).
- **0.6.0** — **Additive.**
  - `entitlements.pull(userId, appId)` — **new, preferred.** HMAC-signed
    pull of the live entitlement from the hub (`GET
    /api/entitlements/[userId]/[appId]`, signed payload `${userId}:${appId}`),
    returning `{ entitled, entitlement }`. Cached in-process ~60s keyed by
    `userId:appId`. `entitlements.invalidate(userId, appId)` busts that cache
    (call it from a webhook handler on `entitlement.updated` / `.revoked`).
  - `entitlements.get` / `check` / `forApp` are now **`@deprecated`** — they
    read the legacy JWT entitlements claim, which is being retired in favor
    of `pull()`. They still work; migrate when convenient.
  - **New `dataShare` namespace** wrapping the app-to-app data-sharing flow:
    `authorize(opts)` (builds the consent-screen URL), `exchangeToken(opts)`
    (POST `/api/oauth/data-share/token`), `introspect(token)` (POST
    `/api/oauth/data-share/introspect`, HMAC, returns `{ active, … }`), and
    `dataShare.profile.getPublic(username)` (GET
    `/api/profile/public/:username`, unauthenticated public card).
  - `publishConfig` switched to public npm + MIT license in preparation for
    the first public release (which ships as 0.9.0).
- **0.5.1–0.5.2** — internal-surface additions (now in
  `@devsforfun/id-sdk-internal`).
- **0.5.0** — `auth.handleCallback` now sends `client_secret` in the
  token-exchange body when one is configured (env
  `DEVSFORFUN_ID_OAUTH_CLIENT_SECRET`, or `oauthClientSecret` in code).
  Required because Supabase's OAuth Server registers our default
  hub-issued clients as confidential / `client_secret_post` —
  without the secret the exchange returns
  `invalid_credentials: client is registered for 'client_secret_post' but 'none' was used`.
  Public clients omit it (no-op).
- **0.4.0** — internal-surface additions (now in `@devsforfun/id-sdk-internal`);
  webhook payloads for calendar-change events gained an enriched delta shape.
- **0.3.0** — **Breaking.** `auth.signIn` and `auth.handleCallback` now
  use a new required config field `oauthClientId` (env
  `DEVSFORFUN_ID_OAUTH_CLIENT_ID`) as the OAuth `client_id`. Previous
  versions passed `projectId` (the UUID used for HMAC), which was always
  wrong — the OAuth code flow keys on `oauth_clients.client_id` (the
  `dff_…` string) while `projects.id` keys the HMAC layer. HMAC-only callers
  (webhooks / entitlements) are unaffected and don't need it.
- **0.2.0** — `webhooks.verifySignature` now enforces a 5-minute timestamp
  freshness window by default (configurable via `{ toleranceSeconds }`).
  Replay-protected at the SDK boundary.
- **0.1.0** — initial release.

## Roadmap

- Helper for Next.js route handlers (`handleAuthCallback(req)`).
- Generated request/response types for every namespace from the hub's public
  OpenAPI spec (the `sessions` namespace already builds on them).
- v1.0: API-stability commitment (see `PUBLISH.md` for the publish flow).
