import crypto from 'node:crypto';
import type { DfidClientConfig, WebhookSubscription } from './types.js';
import { projectHeaders, signProjectBody } from './hmac.js';

export function createWebhooks(config: DfidClientConfig) {
    return {
        async subscribe(userId: string, resource: string, endpointUrl: string): Promise<WebhookSubscription> {
            const body = JSON.stringify({ user_id: userId, resource, endpoint_url: endpointUrl });
            const headers = {
                'Content-Type': 'application/json',
                ...projectHeaders(config.projectId, config.hmacSecret, body),
            };
            const res = await fetch(`${config.url}/api/webhooks/subscriptions`, {
                method: 'POST',
                headers,
                body,
            });
            if (!res.ok) {
                const err = (await res.json().catch(() => null)) as { error?: string } | null;
                throw new Error(err?.error ?? `subscribe failed: ${res.status}`);
            }
            return (await res.json()) as WebhookSubscription;
        },

        async unsubscribe(subscriptionId: string): Promise<void> {
            const headers = {
                'X-DFF-Project': config.projectId,
                'X-DFF-Signature': signProjectBody(config.hmacSecret, subscriptionId),
            };
            const res = await fetch(
                `${config.url}/api/webhooks/subscriptions/${encodeURIComponent(subscriptionId)}`,
                { method: 'DELETE', headers },
            );
            if (!res.ok) {
                const err = (await res.json().catch(() => null)) as { error?: string } | null;
                throw new Error(err?.error ?? `unsubscribe failed: ${res.status}`);
            }
        },

        async publishEvent(eventType: string, userId: string, data: unknown): Promise<{ event_id: string; enqueued: number }> {
            const body = JSON.stringify({ event_type: eventType, user_id: userId, data });
            const headers = {
                'Content-Type': 'application/json',
                ...projectHeaders(config.projectId, config.hmacSecret, body),
            };
            const res = await fetch(`${config.url}/api/webhooks/events/publish`, {
                method: 'POST',
                headers,
                body,
            });
            if (!res.ok) {
                const err = (await res.json().catch(() => null)) as { error?: string } | null;
                throw new Error(err?.error ?? `publish failed: ${res.status}`);
            }
            return (await res.json()) as { event_id: string; enqueued: number };
        },

        // HMAC verification for inbound webhooks. The hub signs over
        // `${timestamp}.${body}` and ships timestamp + signature as
        // X-Webhook-Timestamp + X-Webhook-Signature.
        //
        // Defaults reject:
        //   - Missing signature or timestamp.
        //   - HMAC mismatch (timing-safe compare).
        //   - Timestamps older than `toleranceSeconds` (default 300 = 5 min)
        //     OR more than `toleranceSeconds` in the future. The future
        //     bound is symmetric to cover clock skew without leaving an
        //     attack window.
        //
        // Subscribers MAY widen the tolerance by passing
        // `{ toleranceSeconds: N }` but the default-on freshness check is
        // the security guarantee — do not pass `Infinity`.
        verifySignature(
            body: string,
            headers: { signature?: string | null; timestamp?: string | null },
            subscriptionSecret: string,
            options: { toleranceSeconds?: number } = {},
        ): boolean {
            const { signature, timestamp } = headers;
            if (!signature || !timestamp) return false;

            const tolerance = options.toleranceSeconds ?? 300;
            const parsed = Date.parse(timestamp);
            if (Number.isNaN(parsed)) return false;
            const skewMs = Math.abs(Date.now() - parsed);
            if (skewMs > tolerance * 1000) return false;

            const expected =
                'sha256=' +
                crypto.createHmac('sha256', subscriptionSecret).update(`${timestamp}.${body}`).digest('hex');
            if (expected.length !== signature.length) return false;
            try {
                return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
            } catch {
                return false;
            }
        },
    };
}
