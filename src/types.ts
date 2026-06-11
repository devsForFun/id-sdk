export type DfidClientConfig = {
    /** Base URL of devsforfun ID, e.g. https://devsforfun.app */
    url: string;
    /** projects.id (uuid) — used for X-DFF-Project on HMAC-authed calls */
    projectId: string;
    /** projects.signing_secret — the HMAC key for project-authed calls */
    hmacSecret: string;
    /**
     * oauth_clients.client_id (e.g. `dff_…`) — required for the user-facing
     * OAuth code flow (auth.signIn / auth.handleCallback). Distinct from
     * projectId: the OAuth flow is keyed on the OAuth client_id, not the
     * project's HMAC identity. Default reads from DEVSFORFUN_ID_OAUTH_CLIENT_ID.
     */
    oauthClientId: string;
    /**
     * oauth_clients plaintext secret. Required when the project's OAuth
     * client is `confidential` (the hub default). Public (PKCE-only)
     * clients omit it. Default reads from DEVSFORFUN_ID_OAUTH_CLIENT_SECRET.
     * Server-only — never ship this to a browser bundle.
     */
    oauthClientSecret?: string;
};

export type Result<T> = { data: T; error?: never } | { data?: never; error: string };

/**
 * Token set returned by the hub's token endpoint — both the authorization-code
 * exchange (auth.handleCallback) and the refresh grant (auth.refreshSession).
 * Refresh-token ROTATION is enabled hub-side: every refresh returns a NEW
 * refresh_token and invalidates the previous one (after a short server-side
 * reuse-grace window). Always persist the newest refresh_token.
 */
export type TokenResponse = {
    access_token: string;
    refresh_token: string;
    id_token?: string;
    token_type: string;
    expires_in: number;
};

export type Profile = {
    id: string;
    email: string | null;
    display_name: string | null;
    username: string | null;
    avatar_url: string;
    linked_providers: string[];
    created_at: string;
    updated_at: string;
};

export type EntitlementRow = {
    feature_code: string;
    granted_at: string;
    expires_at: string | null;
    metadata: Record<string, unknown> | null;
    app: { slug: string; title?: string } | null;
};

/**
 * The entitlement row returned by the HMAC pull endpoint
 * (`GET /api/entitlements/[userId]/[appId]`). Distinct from the JWT-claim
 * `EntitlementRow` shape — this is the live row straight from the hub's
 * `entitlements` table.
 */
export type PulledEntitlement = {
    feature_code: string;
    granted_at: string;
    expires_at: string | null;
    revoked_at: string | null;
};

export type WebhookSubscription = {
    subscription_id: string;
    signing_secret: string;
    created_at: string;
};

export type DfidSession = {
    sub: string;
    email?: string;
    aud?: string;
    role?: string;
    entitlements?: string[];
    iat?: number;
    exp?: number;
    [k: string]: unknown;
};
