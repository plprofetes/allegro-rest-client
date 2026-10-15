# Modernization plan

Goal: modernize the library while keeping the public API source- and behaviour-compatible, and keep it **lean and multipurpose**. Higher-level concerns (multi-process token coordination, domain-specific retry rules, application-level logging) are injected from outside; the library ships sensible defaults.

Status: planned, nothing implemented yet. Analysis date: 2026-10-15, baseline `1.1.1`.

## Analysis summary

- Runtime deps: `request` (deprecated; critical/high advisories via `form-data`, `json-schema`, `qs`) and `jsonwebtoken` 8 (used only to decode one claim). `yarn audit` reports 16 findings, all from these two.
- Dev tooling is 3-4 majors behind (TypeScript 3.9, jest 26, eslint 7, prettier 2).
- Bugs found by code reading (not yet reproduced against the live API):
  - `JSON.parse` runs inside the `request` callback, so a non-JSON body (e.g. a 502 HTML page) is an uncaught exception.
  - HTTP status is ignored; failure is detected only via `body.error` / `body.errors`.
  - Token calls put `refresh_token` / `code` / `device_code` in the query string; `redirect_uri` is not URL-encoded and becomes the literal string `undefined` when unset.
  - Default in-memory storage has a mismatched signature and only works by accident.
  - `bindApp` is typed as always present but is `undefined` for `type: 'web'`; the `Error` export shadows the global; return types do not match thrown values.
- Tests: 2, both hit the live sandbox; one passes vacuously (`try/catch` without assertions).

## Targets

- Node **>=24** (current LTS); CI also on 26.
- TypeScript **6.0.x**. `ts-jest` and `typescript-eslint` do not yet support 7, so add a non-blocking `tsc` 7 canary job.
- Dual **CJS + ESM** build via plain `tsc` and an `exports` map with per-condition types. ESM-only is not an option: CommonJS consumers on `module: node16` cannot `require()` an ESM-only package.
- Zero runtime dependencies (native `fetch`, manual JWT payload decode).

## Compatibility contract (frozen by contract tests)

- The `AllegroRestClient(config, options)` factory and the existing methods/exports stay.
- Rejections keep their shapes: `{ error, error_description }`, `{ errors: [...] }`, and `error: 'request_err'` for transport failures. HTTP status/headers are exposed on **non-enumerable** properties so `Object.keys` of an error is unchanged.
- `storage.get(account)` is called **once at construction**; storage implementations may rely on that. Per-request re-reads are opt-in only (Phase 2).
- `bindApp` stays `undefined` for `type: 'web'`; `getExpiresInHours()` still returns a string; `config.type` stays assignable from a plain `string`.
- Generic parameters default to `any`, so existing untyped call sites keep compiling.
- The default policy does not retry transport errors (callers may already do so; retries must not multiply).

## Phase 1: minimal

- [ ] Toolchain: Node >=24, TypeScript 6, dual CJS/ESM build, `node --test`, ESLint 10 (flat), prettier 3. Remove `request`, `jsonwebtoken`, `node-storage`, `uuid`, `ts-node`, `ts-loader`, jest.
- [ ] Native `fetch` transport. Keep the `request` option subset: `method`, `headers`, `body`, `qs`, `form`, `json`, `timeout`.
- [ ] Same factory/methods, plus `patch` and a `defaultHeaders` / `userAgent` option applied to API **and** token calls.
- [ ] Stateless exports (`refreshTokens`, `requestDeviceCode`, `exchangeDeviceCode`, `getExpiresInHours`); the client composes them.
- [ ] `refreshThresholdHours` option (default 1; `0` disables built-in refresh).
- [ ] Fixes: omit `redirect_uri` when unset, send secrets in a form body, never crash on non-JSON bodies, honour HTTP status.
- [ ] Injectable `ResponsePolicy` (`return` | `retry {delayMs}` | `throw {error}`) with injectable sleep/clock.
  - Default: retry 429 honouring `Retry-After` (max 3 attempts, capped); legacy-shaped errors otherwise.
  - Opt-in helper for transient (transport / 502-504) retries.
- [ ] `logger?: boolean | Logger` with a pino-style `(obj, msg)` signature; console when `true`.
- [ ] Typed storage interface (`{ get, set }`, same shape as today) and a typed client interface.
- [ ] Spec pipeline:
  - a committed, dated copy of the official spec (`https://developer.allegro.pl/swagger.yaml`) as backup;
  - `npm run spec:update` fetches the latest and falls back to the committed file;
  - `npm run generate` writes `src/generated/api.d.ts` with `openapi-typescript` and **fails if the spec file is missing**.
- [ ] Offline test suite with an injected `fetch`.
  - **Drift test**: regenerates types in memory and compares with the committed output (also checks the generator is deterministic).
  - Type-level assertions compiled with `tsc`.
  - Live sandbox tests are opt-in via `ALLEGRO_LIVE=1`.
- [ ] CI (lint, build, test, TS 7 canary) and a CJS (`node16`) + ESM consumer smoke test.
- [ ] Give the existing tests real assertions; move sample credentials out of README/tests (use env vars) and rotate them.

**Out of scope:** refresh de-duplication and multi-process locking. Storage implementations own coordination; the README will say so.

## Phase 2: nice to have (additive)

- [ ] Client generic over a **paths type**: `AllegroRestClient<Paths = AllegroPaths>`.
  - Typed overloads `get<P extends GetPath<Paths>>(path)` infer response/query types; unknown string paths still work and return `any`.
  - Consumers can plug in their **own type system** (hand-written or generated from another spec, e.g. for APIs the public spec does not cover) without forking the library.
- [ ] Generated operation -> `Accept` media type map, so beta endpoints get the right header automatically.
- [ ] `raw` response mode (status, headers, binary/stream) so every verb can go through one path.
- [ ] Policy context gains `refresh()`, so a 401 can refresh tokens and retry.
- [ ] `AbortSignal` and timeouts; per-request policy override; request/response hooks.
- [ ] Opt-in per-request token source / storage re-read (documented side effects).
- [ ] `client_credentials` flow.
- [ ] Pagination async iterators.
- [ ] Documented storage adapter examples (file, SQL, Redis).

## Phase 3: ideas

- Device-flow poller with injectable persistence (`authorization_pending` / `slow_down` handling).
- `storage.withRefreshLock(fn)` so lock protocols are injected, not built in.
- Client-side rate limiter / queue.
- Generated per-operation SDK methods (270 unique `operationId`s in the current spec).
- Optional runtime response validation generated from the spec.
- Mock server generated from the spec for consumer tests.
- OpenTelemetry tracing.
- Biome instead of ESLint + prettier.
- Release automation (changesets, npm provenance), typedoc, JSR publishing.
- Scheduled workflow that opens a PR when the upstream spec changes.

## Notes

- Spec facts (file dated 2026-10-15): OpenAPI 3.0.0, 204 paths, 270 operations, 982 schemas, 11 deprecated operations, all `operationId`s unique. `openapi-typescript` 7.13 generates a ~1.4 MB `.d.ts` in ~1.3 s. It declares a TypeScript `^5` peer, so generation on 6 needs a spike. Ship generated types behind a type-only subpath to keep consumers' `tsc` fast.
- Allegro documents 429 on only a couple of operations, so the default policy must handle 429 / `Retry-After` generically.
- Not verified (Allegro hosts were not reachable from the analysis environment): upstream docs/changelog, refresh-token rotation semantics, and the crash scenario above.
