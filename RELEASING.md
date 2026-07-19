# Releasing (maintainers)

1. Bump `version` in `package.json` (strict semver; pre-1.0 minors may break).
2. Add a changelog entry under `## Changelog` in `README.md`.
3. PR → merge to `main` (CI must be green).

That's it — merging a `package.json` version bump to `main` is the entire
release trigger. `auto-release.yml` builds, tests, publishes to npm, and
creates the tag + GitHub Release, all in one job (idempotent — it no-ops if
`v<version>` is already tagged, so unrelated `package.json` edits that don't
change `version` are harmless).

It's intentionally a single workflow rather than "tag, then let a
release-triggered workflow react to it": GitHub Actions refuses to let events
created by the default `GITHUB_TOKEN` kick off a second workflow run (its
built-in anti-recursion protection), so that split design creates the tag but
silently never publishes. If you're ever tempted to re-split this, don't —
that's exactly the bug this file used to describe before it got fixed.

## npm auth — do this once

Trusted publishing (OIDC, no secret to hold or rotate) is preferred, and the
workflow is already wired for it (`permissions: id-token: write`, npm pinned
to >=11.5 via the `npm@11` install step):

1. On npmjs.com → `@devsforfun/id-sdk` package → **Settings → Trusted
   Publisher** → add a GitHub Actions publisher:
   - Organization / repo: `devsForFun/id-sdk`
   - Workflow filename: `auto-release.yml`
   - Environment: leave blank (none configured)
2. That's it — no GitHub secret needed. `npm publish` auto-detects the OIDC
   token when running inside that exact workflow.

**Until that's configured** (or as a fallback), set an `NPM_TOKEN` repo
secret (Automation-type token, scoped to `@devsforfun/id-sdk`, from npmjs.com
→ Access Tokens): `gh secret set NPM_TOKEN --repo devsForFun/id-sdk`. The
workflow already falls back to it via `NODE_AUTH_TOKEN`.

**Neither is configured as of this writing** — confirmed via `gh secret
list` (empty) and the fact that `release.yml` never once completed a
successful run. The 0.10.0/0.11.0 versions on npm were published manually
from a local checkout. Set up trusted publishing before relying on this
workflow to actually publish anything.

## Manual publish (fallback / first bootstrap)

`npm login && npm publish --access public` from a clean checkout (run `npm
run build` first). Note for devsforfun machines: `~/.npmrc` may map the
`@devsforfun` scope to GitHub Packages — the committed `.npmrc` in this repo
pins publishes to registry.npmjs.org so that override cannot hijack a
release.

After publishing to npm, mirror to GitHub Packages so existing first-party
`.npmrc` setups keep resolving:
`npm publish --registry=https://npm.pkg.github.com`.
