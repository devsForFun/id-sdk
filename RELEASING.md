# Releasing (maintainers)

1. Bump `version` in `package.json` (strict semver; pre-1.0 minors may break).
2. Add a changelog entry under `## Changelog` in `README.md`.
3. PR → merge to `main` (CI must be green).

That's it — merging a `package.json` version bump to `main` is the entire
release trigger. `auto-release.yml` builds, tests, publishes to npm,
mirrors the publish to GitHub Packages, and creates the tag + GitHub
Release, all in one job (idempotent — it no-ops if `v<version>` is already
tagged, so unrelated `package.json` edits that don't change `version` are
harmless).

It's intentionally a single workflow rather than "tag, then let a
release-triggered workflow react to it": GitHub Actions refuses to let events
created by the default `GITHUB_TOKEN` kick off a second workflow run (its
built-in anti-recursion protection), so that split design creates the tag but
silently never publishes. If you're ever tempted to re-split this, don't —
that's exactly the bug this file used to describe before it got fixed.

## npm auth

**Trusted publishing (OIDC) is configured and confirmed working** as of
v0.11.3 — no secret held or rotated. Set up on npmjs.com → `@devsforfun/id-sdk`
package → Settings → Trusted Publisher → GitHub Actions publisher for
`devsForFun/id-sdk`, workflow filename `auto-release.yml`, no environment.
The workflow is wired for it (`permissions: id-token: write`, npm pinned to
>=11.5 via the `npm@11` install step).

If trusted publishing is ever removed/broken, the workflow falls back to an
`NPM_TOKEN` repo secret (Automation-type token, scoped to
`@devsforfun/id-sdk`, from npmjs.com → Access Tokens):
`gh secret set NPM_TOKEN --repo devsForFun/id-sdk`.

The GitHub Packages mirror publish uses the default `GITHUB_TOKEN` (given
`permissions: packages: write`) — no separate token needed, since that's a
write to a package associated with this same repo.

## Manual publish (fallback / first bootstrap)

`npm login && npm publish --access public` from a clean checkout (run `npm
run build` first). Note for devsforfun machines: `~/.npmrc` may map the
`@devsforfun` scope to GitHub Packages — the committed `.npmrc` in this repo
pins publishes to registry.npmjs.org so that override cannot hijack a
release.

After publishing to npm, mirror to GitHub Packages so existing first-party
`.npmrc` setups keep resolving: `npm publish --registry=https://npm.pkg.github.com`
(the automated workflow already does this — only needed if publishing by hand).
