import type { DfidClientConfig, Profile } from './types.js';
import { projectHeaders } from './hmac.js';

export function createProfile(config: DfidClientConfig) {
    return {
        // User-authed: caller supplies the user's access_token.
        async getMe(accessToken: string): Promise<Profile> {
            const res = await fetch(`${config.url}/api/profile/me`, {
                headers: { Authorization: `Bearer ${accessToken}` },
            });
            if (!res.ok) throw new Error(`getMe failed: ${res.status}`);
            return (await res.json()) as Profile;
        },

        async updateMe(
            accessToken: string,
            data: Partial<Pick<Profile, 'display_name' | 'username'>>,
        ): Promise<Profile> {
            const res = await fetch(`${config.url}/api/profile/me`, {
                method: 'PATCH',
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(data),
            });
            if (!res.ok) {
                const err = (await res.json().catch(() => null)) as { error?: string } | null;
                throw new Error(err?.error ?? `updateMe failed: ${res.status}`);
            }
            return (await res.json()) as Profile;
        },

        async uploadAvatar(
            accessToken: string,
            file: Blob,
        ): Promise<{ avatar_url: string; path: string }> {
            const form = new FormData();
            form.append('file', file);
            const res = await fetch(`${config.url}/api/profile/me/avatar`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${accessToken}` },
                body: form,
            });
            if (!res.ok) {
                const err = (await res.json().catch(() => null)) as { error?: string } | null;
                throw new Error(err?.error ?? `uploadAvatar failed: ${res.status}`);
            }
            return (await res.json()) as { avatar_url: string; path: string };
        },

        // Project-HMAC: look up another user's profile (subject to consent gate
        // on the server — requesting project must have OAuth authorization).
        async getUser(userId: string): Promise<Profile> {
            const headers = projectHeaders(config.projectId, config.hmacSecret, userId);
            const res = await fetch(`${config.url}/api/profile/${encodeURIComponent(userId)}`, {
                headers,
            });
            if (!res.ok) {
                const err = (await res.json().catch(() => null)) as { error?: string } | null;
                throw new Error(err?.error ?? `getUser failed: ${res.status}`);
            }
            return (await res.json()) as Profile;
        },
    };
}
