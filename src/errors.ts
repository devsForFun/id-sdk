// OAuth/OIDC error taxonomy for the token endpoint. The hub returns RFC 6749
// envelopes ({ error, error_description }); network-level failures and rate
// limits are folded into the same class so callers can branch on `code`,
// `requiresReauth`, and `isTransient` without string-matching messages.

export type OAuthErrorCode =
    | 'invalid_request'
    | 'invalid_client'
    | 'invalid_grant'
    | 'unsupported_grant_type'
    | 'rate_limited'
    | 'server_error'
    | 'network_error'
    | (string & {});

export class DfidOAuthError extends Error {
    readonly code: OAuthErrorCode;
    /** HTTP status of the token response, or null when the request never completed. */
    readonly status: number | null;
    /** RFC 6749 error_description, when the hub provided one. */
    readonly description?: string;
    /** Parsed Retry-After (seconds) on 429 responses. */
    readonly retryAfterSeconds?: number;

    constructor(opts: {
        code: OAuthErrorCode;
        status: number | null;
        description?: string;
        retryAfterSeconds?: number;
    }) {
        super(opts.description ? `${opts.code}: ${opts.description}` : opts.code);
        this.name = 'DfidOAuthError';
        this.code = opts.code;
        this.status = opts.status;
        this.description = opts.description;
        this.retryAfterSeconds = opts.retryAfterSeconds;
    }

    /**
     * The grant itself is dead — expired, revoked, or rotated beyond the
     * server's reuse window. (On refresh, a failed client_secret check is
     * flattened into the same `invalid_grant` by the hub.) Clear the stored
     * session and send the user through sign-in again; retrying cannot succeed.
     */
    get requiresReauth(): boolean {
        return this.code === 'invalid_grant';
    }

    /** Transient failure — a later retry with the SAME inputs may succeed. */
    get isTransient(): boolean {
        return (
            this.code === 'network_error' ||
            this.code === 'server_error' ||
            this.code === 'rate_limited'
        );
    }
}
