# Contributing to @devsforfun/id-sdk

Thanks for helping improve the SDK! This package is the typed Node client for
[devsforfun ID](https://devsforfun.app)'s **public third-party surface**
(auth, profile, entitlements, webhooks, data-share, sessions).

## Dev setup

```bash
npm install
npm test            # vitest, fully network-mocked
npm run typecheck
npm run build       # tsup → dist/ (ESM + CJS + d.ts)
```

Node ≥ 18. No credentials are needed for development — every test stubs
`fetch`.

## Pull requests

- Tests are required for behavior changes; keep them network-mocked.
- Match the existing code style (4-space indent, no shared fetch wrapper —
  each namespace owns its calls).
- API-surface changes need a README update (the Surface table + a changelog
  entry under `## Changelog`, labelled **Additive** or **Breaking**).
- Versioning is strict semver, pre-1.0: minor bumps may break, and maintainers
  handle version bumps at release time — don't bump versions in PRs.

## Scope boundary (please read before proposing endpoints)

This SDK covers only the **public, third-party-granted** API surface of
devsforfun ID. Endpoints that the hub reserves for first-party apps (they
return `403` for third-party credentials) are deliberately absent and PRs
adding them will be declined. If an endpoint is missing from the
[developer-portal API reference](https://devsforfun.app/developer), it is not
part of the public contract.

Server-side behavior (the hub itself) is not in this repo; if a hub bug
blocks you, open an issue describing the observed HTTP behavior.
