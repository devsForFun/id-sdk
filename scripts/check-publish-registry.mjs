#!/usr/bin/env node
// Lightweight pre-publish guard. Runs as `prepublishOnly`.
//
// @devsforfun/id-sdk is now PUBLIC on npm (publishConfig targets
// registry.npmjs.org / access:public). We no longer gate on the registry —
// the old GitHub-Packages-only guard is gone. What we DO still guard:
//
//   - A build must have run: dist/ must contain the ESM, CJS, and type
//     artifacts the package.json `exports`/`main`/`module`/`types` point at.
//     This catches `npm publish` against a missing or stale `dist/` (e.g.
//     forgetting `npm run build` after editing src), which would ship a
//     broken or empty tarball to the public registry.
//
// To skip the check (CI that builds + publishes in one verified step, or a
// deliberate re-publish of an already-built tree): set SKIP_PUBLISH_BUILD_CHECK=1.

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

if (process.env.SKIP_PUBLISH_BUILD_CHECK === '1') {
    process.stderr.write('\nSKIP_PUBLISH_BUILD_CHECK=1 — skipping dist build check.\n\n');
    process.exit(0);
}

const here = dirname(fileURLToPath(import.meta.url));
const distDir = resolve(here, '..', 'dist');

// The exact artifacts the package.json `exports` map points to. If any is
// missing, the published package would be unimportable.
const required = ['index.js', 'index.cjs', 'index.d.ts'];
const missing = required.filter((f) => !existsSync(resolve(distDir, f)));

if (missing.length > 0) {
    const msg = [
        '',
        '──────────────────────────────────────────────────────────────',
        'Refusing to publish @devsforfun/id-sdk — build artifacts missing.',
        '',
        `  dist/ is missing: ${missing.join(', ')}`,
        '',
        'Run `npm run build` from packages/id-sdk before publishing, or set',
        'SKIP_PUBLISH_BUILD_CHECK=1 if you have already built this tree.',
        '──────────────────────────────────────────────────────────────',
        '',
    ].join('\n');
    process.stderr.write(msg);
    process.exit(1);
}
