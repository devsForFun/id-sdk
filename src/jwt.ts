import type { DfidSession } from './types.js';

// Decodes a JWT without verifying the signature. Satellite apps that need
// signature verification should use @supabase/ssr — devsforfun ID JWTs are
// minted by GoTrue and verifiable via the public JWKS endpoint.

export function decodeJwt(token: string): DfidSession {
    const parts = token.split('.');
    if (parts.length !== 3) throw new Error('Not a JWT');
    const payloadB64 = parts[1]!.replace(/-/g, '+').replace(/_/g, '/');
    const padded = payloadB64 + '='.repeat((4 - (payloadB64.length % 4)) % 4);
    const json = Buffer.from(padded, 'base64').toString('utf8');
    return JSON.parse(json) as DfidSession;
}
