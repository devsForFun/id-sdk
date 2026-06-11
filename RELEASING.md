# Releasing (maintainers)

1. Bump `version` in `package.json` (strict semver; pre-1.0 minors may break).
2. Add a changelog entry under `## Changelog` in `README.md`.
3. PR → merge to `main` (CI must be green).
4. Create a GitHub Release with tag `v<version>` — the `release.yml` workflow
   builds, tests, and publishes to npm with `--provenance`.

## npm auth for the workflow

Preferred: **npm trusted publishing** (OIDC, no token). On npmjs → package →
Settings → Trusted publishers → GitHub Actions, set repository
`devsForFun/id-sdk` and workflow `release.yml`. The workflow already requests
`id-token: write`.

Until trusted publishing is configured (or for the very first publish if npm
won't accept OIDC for a new package), set an `NPM_TOKEN` repo secret
(granular, publish-only, scoped to `@devsforfun/id-sdk`) — the workflow falls
back to it automatically.

The inaugural publish can also be done locally: `npm login && npm publish
--access public` from a clean checkout (run `npm run build` first). Note for
devsforfun machines: `~/.npmrc` may map the `@devsforfun` scope to GitHub
Packages — the committed `.npmrc` in this repo pins publishes to
registry.npmjs.org so that override cannot hijack a release.

After publishing to npm, mirror to GitHub Packages so existing first-party
`.npmrc` setups keep resolving:
`npm publish --registry=https://npm.pkg.github.com`.
