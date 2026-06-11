import crypto from 'node:crypto';

// Project-HMAC scheme used across devsforfun ID's project-authed endpoints:
//   X-DFF-Project:   <projects.id>
//   X-DFF-Signature: sha256=<hex hmac-sha256 of body with signing_secret as key>

export function signProjectBody(signingSecret: string, body: string): string {
    return 'sha256=' + crypto.createHmac('sha256', signingSecret).update(body).digest('hex');
}

export function projectHeaders(projectId: string, signingSecret: string, body: string): Record<string, string> {
    return {
        'X-DFF-Project': projectId,
        'X-DFF-Signature': signProjectBody(signingSecret, body),
    };
}
