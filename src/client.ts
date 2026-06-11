import type { DfidClientConfig } from './types.js';
import { createAuth } from './auth.js';
import { createProfile } from './profile.js';
import { createEntitlements } from './entitlements.js';
import { createWebhooks } from './webhooks.js';
import { createDataShare } from './data-share.js';
import { createSessions } from './sessions.js';

// The PUBLIC satellite client — the third-party-granted integration surface
// only ("Sign in with devsforfun ID", profile, entitlements, webhooks,
// data-share, per-app sessions). First-party-only surfaces (Google proxy,
// payments, agents, billing) live in @devsforfun/id-sdk-internal
// (GitHub Packages, restricted) — first-party capability is
// devsforfun-internal and is deliberately absent from this public package.

export type DfidClient = ReturnType<typeof createDfidClient>;

export function createDfidClient(config: Partial<DfidClientConfig> = {}): {
    auth: ReturnType<typeof createAuth>;
    profile: ReturnType<typeof createProfile>;
    entitlements: ReturnType<typeof createEntitlements>;
    webhooks: ReturnType<typeof createWebhooks>;
    dataShare: ReturnType<typeof createDataShare>;
    sessions: ReturnType<typeof createSessions>;
    config: DfidClientConfig;
} {
    const resolved: DfidClientConfig = {
        url: config.url ?? process.env.DEVSFORFUN_ID_URL ?? 'https://devsforfun.app',
        projectId: config.projectId ?? process.env.DEVSFORFUN_ID_PROJECT_ID ?? '',
        hmacSecret: config.hmacSecret ?? process.env.DEVSFORFUN_ID_HMAC_SECRET ?? '',
        oauthClientId:
            config.oauthClientId ?? process.env.DEVSFORFUN_ID_OAUTH_CLIENT_ID ?? '',
        oauthClientSecret:
            config.oauthClientSecret ??
            process.env.DEVSFORFUN_ID_OAUTH_CLIENT_SECRET ??
            undefined,
    };

    if (!resolved.projectId) {
        throw new Error('Missing DEVSFORFUN_ID_PROJECT_ID — set the env var or pass projectId.');
    }
    if (!resolved.hmacSecret) {
        throw new Error('Missing DEVSFORFUN_ID_HMAC_SECRET — set the env var or pass hmacSecret.');
    }
    // oauthClientId is only strictly required for the auth.* methods. Defer
    // the throw to auth.signIn / auth.handleCallback so HMAC-only callers
    // (webhooks/entitlements) don't need to set it.

    return {
        config: resolved,
        auth: createAuth(resolved),
        profile: createProfile(resolved),
        entitlements: createEntitlements(resolved),
        webhooks: createWebhooks(resolved),
        dataShare: createDataShare(resolved),
        sessions: createSessions(resolved),
    };
}
