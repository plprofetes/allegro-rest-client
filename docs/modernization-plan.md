# Modernization plan

Goal: turn `allegro-rest-client` into a lean, zero-dependency, typed client that a team would choose over writing its own. Auth lifecycle and transport live in the library; policy decisions (retries, locking across processes, logging, metrics) are injected from outside, with defaults and presets provided.

Status: Phase 1a and 1b implemented on the working branch (see "Implementation status" at the end); Phase 2 and 3 are planned. Baseline `1.1.1`. Analysis date 2026-10-15. Reviewed once for code correctness and once from a consumer-adoption point of view; both reviews are folded in below.

## Release and compatibility stance

- This is **2.0.0**. The Node floor, an `exports` map (deep imports such as `allegro-rest-client/dist/...` stop working), and the dropped `request` options are breaking by nature. Within that, **runtime behaviour stays as close to 1.x as possible**: same factory, methods, error shapes, and defaults. Anything that changes behaviour is listed under "Behaviour changes" and in the migration guide.
- Semver is followed from here on. Public API surface is snapshotted (Phase 2). Deprecations are announced one minor ahead.
- Optional: a final 1.x patch release fixing only the crash and secrets-in-query bugs, for consumers who cannot move yet.
- Supported matrix: Node **22** (floor), 24 (LTS), 26. The emitted `.d.ts` must work for consumers on TypeScript >=5.0 (CI consumer fixtures); the library itself is built with TypeScript 6.

## Analysis summary (baseline `1.1.1`)

Confirmed by code reading and the published package; none reproduced against the live API.

- Dependencies: `request` (deprecated; critical/high advisories via `form-data`, `json-schema`, `qs`) and `jsonwebtoken` 8 (used to decode one claim). `yarn audit`: 16 findings, all from these two. Dev tooling is 3-4 majors behind (TypeScript 3.9, jest 26, eslint 7, prettier 2).
- `JSON.parse` of response bodies:
  - In API calls it throws inside a synchronous callback: uncaught exception (process crash) on a non-JSON body such as a 502 HTML page.
  - In token calls the callbacks are `async`, so the same failure (or a failing `storeTokens`) becomes an unhandled rejection and the returned promise **never settles**.
  - `json: true` always crashes (`request` has already parsed the body), so nobody can rely on it.
- HTTP status is ignored; failure is detected only via a top-level `error` / `errors` field in the body. Some endpoints (shipment create/cancel/pickup command status) return **200 with a top-level `errors`**, which is rejected today.
- Token calls put `refresh_token`, `code`, `device_code` in the query string, unencoded. `redirect_uri` is unencoded and becomes the literal string `undefined` when `url_redirect` is unset.
- Default in-memory storage is declared `set(tokens)` but called as `set(account, tokens)`, so it stores the account name; it only works because tokens are also cached in the closure.
- Tokens supplied without `created_at` make `getExpiresInHours` return 0, which triggers a refresh on every request.
- `options.storage` throws if `options` is omitted.
- Types: the exported `Error` shadows the global; return types claim `Promise<AuthResponse | Error>` but errors are thrown as plain objects; `storage` is `any`; `noImplicitAny` is off. (`bindApp` is already typed as possibly `undefined`.)
- `PATCH` already works through `request(endpoint, { method: 'PATCH' })`.
- Three operations are served from a different host (`upload.{environment}`) and cannot be called at all today because the API host is hardcoded: `/sale/images`, `/sale/offer-attachments/{id}`, `/after-sales-service-conditions/attachments/{id}`. 23 request bodies are binary and one is multipart.
- Tests: 2, both live-sandbox; one passes vacuously (`try/catch` with no assertions).
- Sample client credentials are committed in `README.md` and `tests/` and therefore in git history.

## Design principles (groundwork for Phase 2)

Phase 1 is deliberately small, but each piece is shaped so Phase 2 only adds code:

- One transport boundary: `send(request) -> Response`, built on an injectable `fetch`.
- One error factory used everywhere, so an error class (`AllegroApiError`) can be added later without touching call sites.
- One event bus for request lifecycle events (`hooks`); the boolean `logger` is implemented on top of it.
- The response policy context is an open object (`{ request, response, error, attempt, kind }`) so fields can be added.
- The client type has a reserved generic slot for a paths type (`AllegroRestClient<Paths = {}>`, untyped by default); unused in Phase 1.
- Auth functions are internal modules with clean inputs/outputs (public exports deferred, see Phase 3).

## Phase 1a: foundation

- [ ] **Toolchain.** Node >=22; TypeScript 6.0.x with a rewritten tsconfig (modern `target`, `module: node16`/`nodenext`, drop `baseUrl`, explicit `types: ["node"]`); `node --test` running against the **built output**; ESLint 10 flat config + typescript-eslint 8 + prettier 3 (separate commit). Remove `request`, `jsonwebtoken`, `node-storage`, `uuid`, `ts-node`, `ts-loader`, jest, ts-jest.
- [ ] **Packaging.** CJS output with an `exports` map (`.` with types, `./package.json`), `engines`, `files`. CJS-only is intentional: it serves both `module: node16` CJS consumers and Node ESM importers (named exports are detected), and avoids the dual-package hazard. Dual output can be added later if demanded. The spec and generator inputs are not published.
- [ ] **Fetch transport** (zero runtime dependencies; JWT payload decoded manually). Supported `request`-style options, with explicit semantics:
  - `method`, `headers`, `body` (string / `Buffer` / `Uint8Array`), `form` (urlencoded), `json` (serialize object body + set content type; response still parsed), `qs`, `timeout` (ms).
  - `qs`: arrays serialize as repeated keys (`types=A&types=B`, the form Allegro documents); nested objects are rejected with a clear error.
  - Options that change semantics and have no equivalent (`jar`, `auth`, `proxy`, `agent`, `pool`, `encoding`, `useQuerystring`, `qsStringifyOptions`) throw `{ error: 'unsupported_option' }`; harmless ones (`gzip`) are ignored.
- [ ] **Same public API.** `AllegroRestClient(config, options)` with optional `options`; same methods and exports; `patch` added; `bindApp` remains `undefined` for `type: 'web'`; `getExpiresInHours()` returns a string; `config.type` stays assignable from a plain `string` (autocomplete hint for `'device' | 'web'`); typed client and storage interfaces. Storage typing is **lenient**: `get` may return a value, `null`/`undefined`, or a promise of either; `set` may return anything.
- [ ] **Behaviour kept.** `storage.get(account)` is called once at construction. Rejections keep the shapes `{ error, error_description }`, `{ errors: [...] }`, `error: 'request_err'`. For `request_err`, `error_description` stays the underlying error object (with `.code` mapped from fetch's `cause.code`, e.g. `ECONNRESET`). Status, headers, and raw body go on **non-enumerable** properties (`Object.keys` unchanged; note they are lost on spread/structured clone). A 200 with a top-level `errors`/`error` is still rejected. Empty body resolves as before.
- [ ] **Fixes.** Never crash or hang on a non-JSON or empty body (a clear rejection instead). Omit `redirect_uri` when unset and URL-encode it. Send token request parameters in a form body, not the URL (verify against the sandbox). Treat tokens without `created_at` as "unknown expiry": derive from the JWT `exp` claim when present, otherwise do not refresh on every request. `refreshThresholdHours` option (default 1; `0` disables built-in refresh). Storage fallback bug fixed.
- [ ] **Injectable response policy** (`ResponsePolicy`): called after every response or transport failure with `{ request, response?, error?, attempt, kind: 'api' | 'token' }` and returns `{ action: 'return' }`, `{ action: 'retry', delayMs }`, or `{ action: 'throw', error }`. Sleep and clock are injectable for tests.
  - **Default policy reproduces 1.x behaviour** (no retries) plus status-aware error shaping: a non-2xx response with neither `error` nor `errors` rejects with `{ error: 'http_error', error_description: 'HTTP <status>' }`.
  - Presets, exported and opt-in: `retry429Policy` (honours `Retry-After` as seconds or HTTP-date, capped, exponential backoff with jitter when absent, API calls only, max 3 attempts), `transientRetryPolicy` (transport errors and 502/503/504, idempotent methods only: never POST/PATCH unless asked), and a `composePolicies` helper.
  - Rationale for a no-retry default: callers may already retry; silently multiplying attempts is a regression risk. Flipping the default to `retry429Policy` is a deliberate decision to revisit before release.
- [ ] **Spec pipeline.**
  - Stable paths: `spec/swagger.yaml` (copy of `https://developer.allegro.pl/swagger.yaml`) plus `spec/spec.meta.json` (source URL, fetch date, sha256).
  - `npm run spec:update` downloads the latest and **fails loudly** if it cannot; offline use is an explicit flag, never a silent fallback.
  - `npm run generate` writes `src/generated/api.d.ts` with `openapi-typescript`, **fails if the spec is missing**, and stamps the spec sha256 into the file header. The generator is pinned to an exact version and runs in an isolated install with TypeScript 5 (its declared peer), so the library's TypeScript 6 does not conflict.
  - Not wired into the client yet; types are not part of the default import path (published later as a type-only subpath).
- [ ] **Tests.** Offline suite with an injected `fetch`: auth flows, refresh, error shaping, policy and presets, option semantics, storage contract. A contract test freezes the compatibility list above. **Drift test**: spec present, sha256 in the generated header matches the spec, in-memory regeneration equals the committed file (also proves determinism). Type-level assertions compiled with `tsc`. A CJS `node16` consumer fixture and a TypeScript 5 consumer fixture in CI. Live sandbox tests are opt-in (`ALLEGRO_LIVE=1`). The existing tests get real assertions.
- [ ] **CI.** Lint, build, test on Node 22/24/26.
- [ ] **Housekeeping.** Move sample credentials out of README and tests (environment variables); **rotate the committed pairs**, as they remain in history. Remove the temporary-storage test helper. Check Allegro's terms for redistributing the spec before keeping it committed (open item).

## Phase 1b: adoption blockers

Added on top of 1a; each item is small because 1a laid the transport, error, hook, and policy boundaries.

- [ ] **Upload host and binary requests.** Per-request host selection (`host: 'upload'` or a `baseUrl` override), sandbox-aware (`upload.allegro.pl` / `upload.allegro.pl.allegrosandbox.pl`). Absolute URLs are accepted only for the Allegro hosts of the active environment, so the bearer token cannot be sent elsewhere. Request bodies pass through unchanged: `Buffer`, `Uint8Array`, `Blob`, `FormData`, and streams (`duplex: 'half'` handled).
- [ ] **Raw responses.** `raw: true` returns the native `Response` (labels, PDFs, CSV, octet-stream); auth, refresh, and policy still apply, JSON parsing and body-based error detection do not.
- [ ] **Cancellation and timeouts.** `signal?: AbortSignal` and `timeout` (ms) combined into one signal; timeouts and aborts surface as `request_err`. (Replaces the earlier separate Phase 1 `timeout` and Phase 2 AbortSignal items.)
- [ ] **Injectable `fetch`** (proxies, undici agents, keep-alive, test doubles).
- [ ] **Lifecycle hooks.** `onRequest`, `onResponse`, `onError`, `onRetry` with method, path, status, duration, attempt, and the Allegro request id header when present (header name to verify). `Authorization` and token parameters are never passed to hooks. The existing `logger: true` is implemented as a built-in console hook.
- [ ] **Per-request policy override** (`opts.policy`).
- [ ] **Error type guards** (`isAllegroError`, `isTransportError`).
- [ ] **Migration guide** from 1.x (options, `qs`, `json`, error details, Node floor, `exports`).

## Phase 2: adoption and ergonomics (ordered; mostly additive)

Likely to be done, so ordered by value:

1. **Quick wins:** `defaultHeaders` / `userAgent` option (applied to API and token calls); pino-style `Logger` object in addition to hooks; storage adapter recipes (file, SQL, Redis) including a locking example.
2. **Typed API.** Opt-in paths type: `AllegroRestClient<AllegroPaths>`; untyped by default so nobody loads the 1.4 MB generated file by accident. Templated calls (`get('/sale/offers/{offerId}', { params: { path, query } })`) or `operationId` calls; no loose string overloads that accept typos. Bring-your-own paths type for APIs the public spec does not cover. Generated operation -> `Accept` media type map. Generated types ship as a type-only subpath.
3. **Errors.** Opt-in `errorMode: 'class'` returning `AllegroApiError` (status, headers, `errors[]`, request id, stack); considered as the default in a later major.
4. **Auth.** `client_credentials` flow; authorization-URL builder for the web flow; device-flow poller (`authorization_pending` / `slow_down`) with injectable persistence and sleep.
5. **Pagination** async iterators (44 paginated operations).
6. **Testing helpers.** Mock `fetch` / recorded-fixture helper for consumers.
7. **Docs.** Quickstart per auth flow; recipes (upload an image, download a label, paginate offers, handle 429, multiple accounts via a shared-config factory); typedoc reference.
8. **Release hygiene.** Changesets, changelog, npm provenance, public-API surface snapshot (api-extractor or similar), deprecation runtime warnings, scheduled workflow that opens a PR when the upstream spec changes, TypeScript 7 canary job.

## Phase 3: ideas

- Public stateless auth functions (`refreshTokens`, `requestDeviceCode`, `exchangeDeviceCode`, `getExpiresInHours`) if consumers ask.
- `storage.withRefreshLock(fn)` so lock protocols are injected rather than built in; refresh de-duplication.
- Client-side rate limiter / request queue.
- Generated per-operation SDK methods (270 unique `operationId`s).
- Optional runtime response validation generated from the spec.
- Mock server generated from the spec.
- OpenTelemetry adapter built on the hooks.
- Dual CJS + ESM output if demanded.
- Biome instead of ESLint + prettier; JSR publishing.

## Out of scope

Refresh-token race handling and multi-process coordination: storage implementations own it. The scenarios that deliberately stay in a consumer's wrapper are listed in [wrapping.md](wrapping.md). Other Allegro APIs not present in the public spec (types can be supplied through the bring-your-own paths type).

## Notes

- Spec facts (file dated 2026-10-15): OpenAPI 3.0.0, 204 paths, 270 operations, 982 schemas, 11 deprecated operations, unique `operationId`s. `openapi-typescript` 7.13 produces a ~1.4 MB `.d.ts` in ~1.3 s and declares a TypeScript `^5` peer.
- Allegro documents 429 on only a couple of operations, so presets must handle 429 / `Retry-After` generically.
- Not verified (Allegro hosts were unreachable from the analysis environment): upstream docs and changelog, refresh-token rotation semantics, the Allegro request-id header name, spec redistribution terms.

## Implementation status

Phase 1a and 1b are implemented; maintenance procedures are in [runbooks.md](runbooks.md). Deviations from the plan above, kept deliberately small (solo-maintainer, KISS):

- No `composePolicies` helper: presets compose through their `next` option.
- The CJS `node16` and TypeScript 5 consumer-fixture CI job was dropped; the test build itself is a `module: node16` CommonJS consumer of the sources. Revisit if consumers report typing problems.
- CI is a single workflow (lint, tests, build) on Node 22 and 24, not 26.
- Hooks, `raw`, `host: 'upload'`, `signal`/`timeout`, injectable `fetch` and per-request `policy` landed together with the transport instead of as a separate step; the console `logger` is implemented on the same hooks.
- The migration guide lives in the README ("Upgrading from 1.x") rather than a separate file.
- `tokenParams` (`'form'` default, `'query'` as the escape hatch) was added because the form-body token requests are **not yet verified against the live Allegro token endpoint**. The live sandbox tests (`.github/workflows/live.yml`, repository secrets) check that Allegro accepts both styles; one real login remains the release gate described in the runbooks.
- Live tests cover the device flow only; testing the web OAuth flow is a possible later addition (see the runbooks).
- Open items: Allegro's terms for redistributing the spec (the README states the retrieval date and ownership), the name of Allegro's request-id response header (the hook checks `trace-id`, `x-trace-id`, `x-request-id`), the original sample credentials that remain in git history and must be rotated.
