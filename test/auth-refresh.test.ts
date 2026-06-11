import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDfidClient, DfidOAuthError } from '../src/index.js';

// Unit tests for the public SDK's token-refresh surface (auth.refreshSession,
// auth.shouldRefresh, the shared token-endpoint error mapping). All network
// I/O is stubbed — these never touch a hub.

const TOKENS = {
    access_token: 'new-access',
    refresh_token: 'new-refresh',
    token_type: 'Bearer',
    expires_in: 3600,
};

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
    return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        ...init,
    });
}

function makeClient(overrides: Record<string, string | undefined> = {}) {
    return createDfidClient({
        url: 'https://hub.test',
        projectId: 'proj',
        hmacSecret: 'secret',
        oauthClientId: 'dff_test',
        ...overrides,
    });
}

function makeJwt(claims: Record<string, unknown>): string {
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    return `${b64({ alg: 'none' })}.${b64(claims)}.sig`;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('auth.refreshSession', () => {
    it('posts a form-encoded refresh grant and returns the token set', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(TOKENS));
        const dfid = makeClient();

        const tokens = await dfid.auth.refreshSession({ refreshToken: 'rt-1' });

        expect(tokens).toEqual(TOKENS);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0]!;
        expect(url).toBe('https://hub.test/api/oauth/token');
        expect(init.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
        const body = new URLSearchParams(init.body as string);
        expect(body.get('grant_type')).toBe('refresh_token');
        expect(body.get('refresh_token')).toBe('rt-1');
        expect(body.get('client_id')).toBe('dff_test');
        expect(body.get('client_secret')).toBeNull();
    });

    it('includes client_secret for confidential clients', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(TOKENS));
        const dfid = makeClient({ oauthClientSecret: 's3cr3t' });

        await dfid.auth.refreshSession({ refreshToken: 'rt-1' });

        const body = new URLSearchParams(fetchMock.mock.calls[0]![1].body as string);
        expect(body.get('client_secret')).toBe('s3cr3t');
    });

    it('maps invalid_grant to requiresReauth and never retries it', async () => {
        fetchMock.mockResolvedValue(
            jsonResponse(
                { error: 'invalid_grant', error_description: 'Refresh token is invalid or expired.' },
                { status: 400 },
            ),
        );
        const dfid = makeClient();

        const err = await dfid.auth.refreshSession({ refreshToken: 'rt-dead' }).catch((e) => e);

        expect(err).toBeInstanceOf(DfidOAuthError);
        expect(err.code).toBe('invalid_grant');
        expect(err.status).toBe(400);
        expect(err.description).toBe('Refresh token is invalid or expired.');
        expect(err.requiresReauth).toBe(true);
        expect(err.isTransient).toBe(false);
        expect(err.message).toBe('invalid_grant: Refresh token is invalid or expired.');
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('maps 429 to rate_limited with retryAfterSeconds and fails fast on a long Retry-After', async () => {
        fetchMock.mockResolvedValue(
            jsonResponse(
                { error: 'invalid_request', error_description: 'Rate limit exceeded.' },
                { status: 429, headers: { 'Retry-After': '30' } },
            ),
        );
        const dfid = makeClient();

        const err = await dfid.auth.refreshSession({ refreshToken: 'rt-1' }).catch((e) => e);

        expect(err).toBeInstanceOf(DfidOAuthError);
        expect(err.code).toBe('rate_limited');
        expect(err.retryAfterSeconds).toBe(30);
        expect(err.isTransient).toBe(true);
        // 30s exceeds the in-call retry budget — exactly one attempt.
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('retries a 5xx and succeeds on the second attempt', async () => {
        fetchMock
            .mockResolvedValueOnce(jsonResponse({ error: 'server_error' }, { status: 502 }))
            .mockResolvedValueOnce(jsonResponse(TOKENS));
        const dfid = makeClient();

        const tokens = await dfid.auth.refreshSession({ refreshToken: 'rt-1' });

        expect(tokens).toEqual(TOKENS);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('retries a thrown network error and succeeds', async () => {
        fetchMock
            .mockRejectedValueOnce(new TypeError('fetch failed'))
            .mockResolvedValueOnce(jsonResponse(TOKENS));
        const dfid = makeClient();

        const tokens = await dfid.auth.refreshSession({ refreshToken: 'rt-1' });

        expect(tokens).toEqual(TOKENS);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('maps any 5xx to server_error even when the body carries an OAuth code', async () => {
        fetchMock.mockResolvedValue(
            jsonResponse({ error: 'oops', error_description: 'db down' }, { status: 500 }),
        );
        const dfid = makeClient();

        const err = await dfid.auth
            .refreshSession({ refreshToken: 'rt-1', retries: 0 })
            .catch((e) => e);

        expect(err).toBeInstanceOf(DfidOAuthError);
        expect(err.code).toBe('server_error');
        expect(err.description).toBe('db down');
        expect(err.isTransient).toBe(true);
    });

    it('treats a 5xx body without an error code as server_error and retries to exhaustion', async () => {
        fetchMock.mockResolvedValue(new Response('not json', { status: 503 }));
        const dfid = makeClient();

        const err = await dfid.auth.refreshSession({ refreshToken: 'rt-1' }).catch((e) => e);

        expect(err).toBeInstanceOf(DfidOAuthError);
        expect(err.code).toBe('server_error');
        expect(err.status).toBe(503);
        // 1 initial + 2 retries
        expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('respects retries: 0', async () => {
        fetchMock.mockResolvedValue(new Response('x', { status: 500 }));
        const dfid = makeClient();

        await expect(
            dfid.auth.refreshSession({ refreshToken: 'rt-1', retries: 0 }),
        ).rejects.toBeInstanceOf(DfidOAuthError);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('rejects a malformed 200 body as server_error', async () => {
        fetchMock.mockResolvedValue(jsonResponse({ nope: true }));
        const dfid = makeClient();

        const err = await dfid.auth
            .refreshSession({ refreshToken: 'rt-1', retries: 0 })
            .catch((e) => e);

        expect(err).toBeInstanceOf(DfidOAuthError);
        expect(err.code).toBe('server_error');
    });

    it('deduplicates concurrent calls with the same refresh token', async () => {
        let release!: (v: Response) => void;
        fetchMock.mockImplementation(
            () => new Promise<Response>((resolve) => (release = resolve)),
        );
        const dfid = makeClient();

        const p1 = dfid.auth.refreshSession({ refreshToken: 'rt-same' });
        const p2 = dfid.auth.refreshSession({ refreshToken: 'rt-same' });
        release(jsonResponse(TOKENS));

        const [t1, t2] = await Promise.all([p1, p2]);
        expect(t1).toEqual(TOKENS);
        expect(t2).toEqual(TOKENS);
        expect(fetchMock).toHaveBeenCalledTimes(1);

        // After settling, the next call hits the network again.
        fetchMock.mockResolvedValueOnce(jsonResponse(TOKENS));
        await dfid.auth.refreshSession({ refreshToken: 'rt-same' });
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('does not deduplicate across different refresh tokens or with dedupe: false', async () => {
        fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(TOKENS)));
        const dfid = makeClient();

        await Promise.all([
            dfid.auth.refreshSession({ refreshToken: 'rt-a' }),
            dfid.auth.refreshSession({ refreshToken: 'rt-b' }),
        ]);
        expect(fetchMock).toHaveBeenCalledTimes(2);

        fetchMock.mockClear();
        await Promise.all([
            dfid.auth.refreshSession({ refreshToken: 'rt-c', dedupe: false }),
            dfid.auth.refreshSession({ refreshToken: 'rt-c', dedupe: false }),
        ]);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('aborts on per-attempt timeout with a transient network_error', async () => {
        fetchMock.mockImplementation(
            (_url: string, init: RequestInit) =>
                new Promise<Response>((_resolve, reject) => {
                    init.signal!.addEventListener('abort', () =>
                        reject((init.signal as AbortSignal).reason ?? new Error('aborted')),
                    );
                }),
        );
        const dfid = makeClient();

        const err = await dfid.auth
            .refreshSession({ refreshToken: 'rt-1', timeoutMs: 30, retries: 0 })
            .catch((e) => e);

        expect(err).toBeInstanceOf(DfidOAuthError);
        expect(err.code).toBe('network_error');
        expect(err.message).toContain('timed out');
    });

    it('bounds a stalled response BODY by timeoutMs (fetch resolved at headers)', async () => {
        fetchMock.mockResolvedValue({
            ok: true,
            status: 200,
            headers: new Headers(),
            json: () => new Promise(() => {}), // body never completes, ignores signals
        } as unknown as Response);
        const dfid = makeClient();

        const err = await dfid.auth
            .refreshSession({ refreshToken: 'rt-1', timeoutMs: 30, retries: 0 })
            .catch((e) => e);

        expect(err).toBeInstanceOf(DfidOAuthError);
        expect(err.code).toBe('network_error');
        expect(err.message).toContain('timed out');
    });

    it('propagates a caller abort that fires during the body read', async () => {
        const controller = new AbortController();
        const reason = new Error('caller aborted mid-body');
        fetchMock.mockResolvedValue({
            ok: true,
            status: 200,
            headers: new Headers(),
            json: () => new Promise(() => {}),
        } as unknown as Response);
        const dfid = makeClient();

        const pending = dfid.auth
            .refreshSession({ refreshToken: 'rt-1', signal: controller.signal, retries: 0 })
            .catch((e) => e);
        setTimeout(() => controller.abort(reason), 20);

        expect(await pending).toBe(reason);
    });

    it('clamps negative/NaN retries to zero instead of rejecting with undefined', async () => {
        fetchMock.mockImplementation(() =>
            Promise.resolve(
                jsonResponse({ error: 'invalid_grant' }, { status: 400 }),
            ),
        );
        const dfid = makeClient();

        const errNeg = await dfid.auth
            .refreshSession({ refreshToken: 'rt-neg', retries: -1 })
            .catch((e) => e);
        const errNan = await dfid.auth
            .refreshSession({ refreshToken: 'rt-nan', retries: Number.NaN })
            .catch((e) => e);

        expect(errNeg).toBeInstanceOf(DfidOAuthError);
        expect(errNan).toBeInstanceOf(DfidOAuthError);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('rejects (not sync-throws) when the OAuth client id is missing', async () => {
        const dfid = makeClient({ oauthClientId: '' });
        const p = dfid.auth.refreshSession({ refreshToken: 'rt-1' }); // must not throw here
        await expect(p).rejects.toThrow('DEVSFORFUN_ID_OAUTH_CLIENT_ID');
    });

    it('honors a pre-aborted caller signal without any network call', async () => {
        const dfid = makeClient();
        const controller = new AbortController();
        const reason = new Error('caller aborted');
        controller.abort(reason);

        const err = await dfid.auth
            .refreshSession({ refreshToken: 'rt-1', signal: controller.signal })
            .catch((e) => e);

        expect(err).toBe(reason);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects an empty refreshToken with invalid_request', async () => {
        const dfid = makeClient();
        const err = await dfid.auth.refreshSession({ refreshToken: '' }).catch((e) => e);
        expect(err).toBeInstanceOf(DfidOAuthError);
        expect(err.code).toBe('invalid_request');
        expect(fetchMock).not.toHaveBeenCalled();
    });
});

describe('auth.shouldRefresh', () => {
    const dfid = makeClient();

    it('is true for missing or undecodable tokens', () => {
        expect(dfid.auth.shouldRefresh(null)).toBe(true);
        expect(dfid.auth.shouldRefresh(undefined)).toBe(true);
        expect(dfid.auth.shouldRefresh('')).toBe(true);
        expect(dfid.auth.shouldRefresh('garbage')).toBe(true);
    });

    it('is true when exp is missing', () => {
        expect(dfid.auth.shouldRefresh(makeJwt({ sub: 'u1' }))).toBe(true);
    });

    it('is false for a fresh token and true within the skew window', () => {
        const now = Math.floor(Date.now() / 1000);
        expect(dfid.auth.shouldRefresh(makeJwt({ exp: now + 3600 }))).toBe(false);
        expect(dfid.auth.shouldRefresh(makeJwt({ exp: now + 30 }))).toBe(true);
        expect(dfid.auth.shouldRefresh(makeJwt({ exp: now - 10 }))).toBe(true);
        // custom skew
        expect(dfid.auth.shouldRefresh(makeJwt({ exp: now + 30 }), { skewSeconds: 5 })).toBe(false);
    });
});

describe('auth.handleCallback error mapping', () => {
    it('throws DfidOAuthError with the hub error_description and never retries', async () => {
        fetchMock.mockResolvedValue(
            jsonResponse(
                { error: 'invalid_grant', error_description: 'Code expired.' },
                { status: 400 },
            ),
        );
        const dfid = makeClient();

        const err = await dfid.auth
            .handleCallback({ code: 'c', codeVerifier: 'v', redirectUri: 'https://app/cb' })
            .catch((e) => e);

        expect(err).toBeInstanceOf(DfidOAuthError);
        expect(err.code).toBe('invalid_grant');
        expect(err.message).toBe('invalid_grant: Code expired.');
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('returns the named TokenResponse shape on success', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({ ...TOKENS, id_token: 'idt' }));
        const dfid = makeClient();

        const tokens = await dfid.auth.handleCallback({
            code: 'c',
            codeVerifier: 'v',
            redirectUri: 'https://app/cb',
        });

        expect(tokens.access_token).toBe('new-access');
        expect(tokens.id_token).toBe('idt');
        const body = new URLSearchParams(fetchMock.mock.calls[0]![1].body as string);
        expect(body.get('grant_type')).toBe('authorization_code');
    });
});
