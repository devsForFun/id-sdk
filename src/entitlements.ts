import { decodeJwt } from './jwt.js';
import { signProjectBody } from './hmac.js';
import type { DfidClientConfig, PulledEntitlement } from './types.js';

// In-memory, short-TTL cache for HMAC entitlement pulls. Keyed by
// `${userId}:${appId}`. Per-process — a serverless instance gets its own
// cache; the TTL keeps stale entitlements bounded without a shared store.
const PULL_TTL_MS = 60_000;
type CacheEntry = { value: { entitled: boolean; entitlement: PulledEntitlement | null }; expiresAt: number };
const pullCache = new Map<string, CacheEntry>();

function cacheKey(userId: string, appId: string): string {
    return `${userId}:${appId}`;
}

export function createEntitlements(config: DfidClientConfig) {
    return {
        /**
         * Pull the live entitlement for `(userId, appId)` directly from the hub
         * over the project-HMAC channel. This is the source of truth — it reads
         * the hub's `entitlements` table, not the (eventually-stale) JWT claim.
         *
         * The signed payload is the literal `${userId}:${appId}` string (matches
         * `GET /api/entitlements/[userId]/[appId]` on the hub). Results are cached
         * in-process for ~60s keyed by `userId:appId`; bust the cache with
         * `invalidate(userId, appId)` from a satellite webhook handler when you
         * receive an `entitlement.updated` event.
         */
        async pull(
            userId: string,
            appId: string,
        ): Promise<{ entitled: boolean; entitlement: PulledEntitlement | null }> {
            const key = cacheKey(userId, appId);
            const cached = pullCache.get(key);
            if (cached && cached.expiresAt > Date.now()) {
                return cached.value;
            }

            const headers = {
                'X-DFF-Project': config.projectId,
                'X-DFF-Signature': signProjectBody(config.hmacSecret, `${userId}:${appId}`),
            };
            const res = await fetch(
                `${config.url}/api/entitlements/${encodeURIComponent(userId)}/${encodeURIComponent(appId)}`,
                { headers },
            );
            if (!res.ok) {
                const err = (await res.json().catch(() => null)) as { error?: string } | null;
                throw new Error(err?.error ?? `entitlements.pull failed: ${res.status}`);
            }
            const value = (await res.json()) as {
                entitled: boolean;
                entitlement: PulledEntitlement | null;
            };
            pullCache.set(key, { value, expiresAt: Date.now() + PULL_TTL_MS });
            return value;
        },

        /**
         * Drop the cached `pull` result for `(userId, appId)`. Call this from a
         * satellite webhook handler on `entitlement.updated` / `entitlement.revoked`
         * so the next `pull` re-fetches instead of serving the stale TTL window.
         */
        invalidate(userId: string, appId: string): void {
            pullCache.delete(cacheKey(userId, appId));
        },

        /**
         * @deprecated Reads the legacy JWT entitlements claim; prefer `pull()` —
         * the claim is being retired in favor of HMAC pull.
         *
         * Pull entitlements directly out of an access token. Cheapest path
         * (no network) — JWTs minted by devsforfun ID carried the entitlement
         * set in a custom claim. That claim is going away; migrate to `pull()`.
         */
        get(accessToken: string): string[] {
            const session = decodeJwt(accessToken);
            return Array.isArray(session.entitlements) ? session.entitlements : [];
        },

        /**
         * @deprecated Reads the legacy JWT entitlements claim; prefer `pull()` —
         * the claim is being retired in favor of HMAC pull.
         *
         * Convenience boolean. Pass either the bare token or a pre-decoded list.
         */
        check(source: string | string[], entitlement: string): boolean {
            const list = typeof source === 'string' ? this.get(source) : source;
            return list.includes(entitlement);
        },

        /**
         * @deprecated Reads the legacy JWT entitlements claim; prefer `pull()` —
         * the claim is being retired in favor of HMAC pull.
         *
         * App-scoped filter — returns only entitlements matching `<slug>:*`.
         */
        forApp(accessToken: string, appSlug: string): string[] {
            const prefix = `${appSlug}:`;
            return this.get(accessToken).filter((e) => e.startsWith(prefix));
        },
    };
}
