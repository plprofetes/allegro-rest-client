# Runbooks

Short, copy-pasteable procedures for the recurring jobs on this repo. Written for a solo maintainer (or an AI assistant) picking the project up cold. Background and roadmap: [modernization-plan.md](modernization-plan.md).

## Contents

1. [Project map](#project-map)
2. [Everyday checks](#everyday-checks)
3. [Refresh the Allegro API spec](#refresh-the-allegro-api-spec)
4. [The drift test fails](#the-drift-test-fails)
5. [Run the live sandbox tests](#run-the-live-sandbox-tests)
6. [Debug a failing request or login](#debug-a-failing-request-or-login)
7. [Change the library (add an option, hook or policy)](#change-the-library)
8. [Release](#release)
9. [Upgrade dependencies and tooling](#upgrade-dependencies-and-tooling)

## Project map

| Path                          | What it is                                                                                                                       |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts`                | The `AllegroRestClient` factory: token lifecycle (store, refresh) and the `get/post/...` methods; exports                        |
| `src/types.ts`                | Every public type, with the option documentation as doc comments                                                                 |
| `src/http.ts`                 | Request building (`buildRequest`) and the single `send` loop (fetch, hooks, policy, retry)                                       |
| `src/policy.ts`               | `defaultPolicy` and the opt-in presets `retry429Policy`, `transientRetryPolicy`                                                  |
| `src/auth.ts`                 | Builds the OAuth token / device requests                                                                                         |
| `src/errors.ts`, `helpers.ts` | Error shapes and guards; JWT decode and `getExpiresInHours`                                                                      |
| `src/generated/api.d.ts`      | **Generated** from the spec. Never edit by hand                                                                                  |
| `spec/`                       | Committed copy of Allegro's OpenAPI spec (`swagger.yaml`) plus `spec.meta.json` (source, retrieval date, sha256)                 |
| `tools/generator/`            | Isolated install (openapi-typescript + TypeScript 5) and `generate.mjs`; kept apart because the library builds with TypeScript 6 |
| `scripts/spec-update.mjs`     | Downloads the latest spec                                                                                                        |
| `test/`                       | Offline tests with a mock `fetch` (`helpers.ts`), plus opt-in live tests                                                         |

Application-level concerns (locking across processes, re-authorization, alerting) belong in a consumer's wrapper, not here: see [wrapping.md](wrapping.md).

Design rules to keep: zero runtime dependencies; one transport function (`send`); one error shape per failure kind; behaviour changes go in the README "Upgrading" section.

## Everyday checks

```sh
npm ci            # first time, or after a lockfile change
npm run lint      # eslint + prettier --check   (npm run format fixes formatting)
npm test          # builds src+test into .build/ and runs node --test (offline, ~5 s)
npm run build     # emits dist/
```

`npm test` compiles TypeScript first, so type errors fail it. Tests run against compiled output in `.build/`, never against `src` directly.

## Refresh the Allegro API spec

The spec is Allegro's, fetched from `https://developer.allegro.pl/swagger.yaml`. Always record when it was retrieved (`spec/spec.meta.json` does this).

```sh
npm run spec:update   # downloads, rewrites spec/swagger.yaml and spec/spec.meta.json (sha256 + today's date)
npm run generate      # installs the isolated generator, rewrites src/generated/api.d.ts
npm test              # the drift test must pass; type assertions in test/types.test.ts must still compile
git diff --stat spec src/generated
```

Before committing, look for **removed or changed paths** in `git diff src/generated/api.d.ts` (removals are breaking for anyone using the generated types). Then:

```sh
git add spec src/generated
git commit -m "chore(spec): refresh Allegro API spec (retrieved YYYY-MM-DD)"
```

`spec:update` fails loudly if the download fails and leaves the committed copy untouched. If the host is unreachable from where you work, download the file in a browser instead and do the bookkeeping by hand:

```sh
cp ~/Downloads/swagger.yaml spec/swagger.yaml
sha256sum spec/swagger.yaml                 # put this in spec/spec.meta.json, with today's date as retrievedAt
npm run generate
```

## The drift test fails

`test/spec-drift.test.ts` has four checks. Find the message, apply the fix:

| Failure                                             | Cause                                         | Fix                                                                    |
| --------------------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------- |
| `spec/swagger.yaml is missing`                      | File deleted or not checked out               | `git checkout spec/` or `npm run spec:update`                          |
| sha256 mismatch between spec and `spec.meta.json`   | Spec edited/replaced without updating meta    | Recompute the sha (see above) or re-run `npm run spec:update`          |
| generated header does not carry the spec sha / date | Spec changed, types not regenerated           | `npm run generate`                                                     |
| `src/generated/api.d.ts is stale`                   | Same, or the generator version changed        | `npm run generate`, review the diff, commit                            |
| `test/types.test.ts` fails to **compile**           | The spec dropped/reshaped something we assert | Decide: adapt the assertion (spec change is legitimate) or investigate |

If the generator itself changed output (after bumping `tools/generator`), regenerating is expected; skim the diff for anything other than formatting.

## Run the live sandbox tests

The offline suite never touches the network. Live tests are opt-in and use an Allegro **sandbox** application you registered (`https://apps.developer.allegro.pl.allegrosandbox.pl`). Never put credentials in the repo; pass them through the environment.

```sh
ALLEGRO_LIVE=1 \
ALLEGRO_CLIENT_ID=... ALLEGRO_CLIENT_SECRET=... ALLEGRO_URL_REDIRECT=https://your-redirect.example \
npm test
```

They check the error shapes returned by the real token endpoint and the missing-token path. **Release gate:** token requests send their parameters in a form body (the 1.x code used the query string). That is standard OAuth and expected to work, but it has not been verified against Allegro. Before every release, do one real login with the built client:

1. Device app: `const { verification_uri_complete, device_code } = await client.bindApp()`, open the URL, approve, then `await client.authorize(device_code)` (it rejects with `authorization_pending` until approved).
2. Then `await client.get('/me')` and a token refresh (`refreshThresholdHours: 13` makes the next request refresh).
3. If the token endpoint rejects the form body, construct the client with `tokenParams: 'query'` and decide whether to change the default.

## Debug a failing request or login

Turn on visibility first:

```ts
const client = await AllegroRestClient(config, {
  logger: true, // console output
  hooks: { onResponse: (e) => console.log(e.status, e.durationMs, e.requestId) },
})
```

Rejections have these shapes (see README "Errors"). `err.status`, `err.headers` and `err.body` are available on HTTP errors and are not enumerable (they will not show in `console.log` of a spread copy).

| `err.error`                             | Meaning / what to check                                                                                                            |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `missing_access_token`                  | No tokens in storage. Authorize first; check `storage.get` returns what `set` saved                                                |
| `invalid_grant`                         | Bad/used code or refresh token. Refresh tokens are one-time: two processes refreshing the same token race; coordinate in `storage` |
| `invalid_token`                         | Access token rejected (expired/revoked). Refresh or re-authorize                                                                   |
| `authorization_pending` / `slow_down`   | Device flow: the user has not approved yet / poll more slowly                                                                      |
| `request_err`                           | Network or timeout. `error_description` is the underlying error (`.code` such as `ECONNRESET`, or a `TimeoutError`)                |
| `http_error`                            | Non-2xx response whose body was not an Allegro error object. See `err.status` and `err.body`                                       |
| `invalid_response`                      | 2xx response that was not JSON. Use `raw: true` (binary/CSV) or a custom policy                                                    |
| `unsupported_option` / `invalid_option` | A 1.x `request` option that no longer exists, or conflicting options (`body` + `json`). Message says which                         |
| `invalid_endpoint`                      | Absolute URL outside the active environment's Allegro hosts (deliberate: protects the bearer token)                                |
| `{ errors: [...] }`                     | Allegro API error body, passed through unchanged                                                                                   |

Typical first questions: sandbox vs production (`sandbox: true` switches every host, including `upload.`); wrong `Accept` for beta endpoints (pass `headers: { Accept: 'application/vnd.allegro.beta.v1+json' }`); a 429 with no retry (retries are opt-in, see the README).

Reproduce a bug offline whenever possible: copy a test from `test/` and use `mockFetch` from `test/helpers.ts` to return the exact response.

## Change the library

Add an **option** to `request()`:

1. Add it to `RequestOptions` in `src/types.ts` with a doc comment.
2. Handle it in `buildRequest` (`src/http.ts`); if it changes how a request is sent, handle it in `send`.
3. Test in `test/transport.test.ts` using the `setup()` helper (`calls[n]` shows exactly what reached `fetch`).
4. Mention it in the README options table.

Add a **client option**: `ClientOptions` in `src/types.ts` → read it in the `AllegroRestClient` factory (`src/index.ts`) → test in the closest test file → README.

Add a **policy preset**: write it in `src/policy.ts` as `(options) => ResponsePolicy` that falls back to `options.next ?? defaultPolicy` (that is how presets compose), export it from `src/index.ts`, test in `test/policy.test.ts` with injected `sleep`/`random`/`now`, document it in the README.

Add a **hook**: add the event type and callback to `ClientHooks` (`src/types.ts`), emit it in `send` (hooks are wrapped in `safe()` so they can never break a request), never include headers or tokens in the event.

Rules of thumb: keep the error shapes stable (`{error, error_description}`, `{errors}`); never read the response body outside `send`; token and API calls share the same `send` and policy (distinguished by `kind`).

## Release

Versions follow semver. Pre-releases use the `next` tag.

```sh
npm ci && npm run lint && npm test && npm run build
npm pack --dry-run          # contents must be dist/, README.md, LICENSE, package.json only
```

1. Do the live login check from [Run the live sandbox tests](#run-the-live-sandbox-tests).
2. If the spec changed since the last release, make sure the README states the retrieval date (it is read from `spec/spec.meta.json`; keep both in sync).
3. Bump `version` in `package.json` (`npm version <x.y.z> --no-git-tag-version`), commit `chore(release): vX.Y.Z`, tag `vX.Y.Z`.
4. `npm publish` (add `--tag next` for pre-releases), push the tag, write release notes (behaviour changes first).

Breaking = anything in the README "Upgrading" list changing again, a raised Node floor, removed exports.

## Upgrade dependencies and tooling

```sh
npm outdated
npm outdated --prefix tools/generator
```

Constraints that bite:

- **TypeScript**: the library builds with 6.x (`typescript-eslint` caps below 6.1, so TypeScript 7 waits for it). `tools/generator` pins TypeScript 5 and `openapi-typescript` exactly, because the generator declares a TypeScript 5 peer; bumping either means `npm run generate`, then reviewing the diff of `src/generated/api.d.ts`.
- **Node floor** (22): lives in `package.json` `engines`, the CI matrix (`.github/workflows/ci.yml`), `@types/node` (keep its major equal to the floor), README. Raising it is a breaking change.
- **ESLint / typescript-eslint**: config is `eslint.config.mjs` (flat). Check peer ranges before bumping a major.

After any bump: `npm run lint && npm test && npm run build`.
