# Changelog

Versions follow [semver](https://semver.org). Breaking changes of 2.0 against 1.x are listed in the README ("Upgrading from 1.x").

## 2.0.0 (unreleased)

Rewrite on `fetch` with zero runtime dependencies, an `exports` map and Node 22+.

- Transport with injectable `fetch`, response policies (`retry429Policy`, `transientRetryPolicy`), hooks, `signal`/`timeout`, `raw`, `host: 'upload'`, `patch`.
- Token handling: form-body OAuth requests (`tokenParams`), `refreshThresholdHours`, `authorizeApp()` (`client_credentials`), `getAuthorizationUrl()`, `pollDevice()`.
- `defaultHeaders` / `userAgent`, pino-style `logger` objects, opt-in `errorMode: 'class'` (`AllegroApiError`).
- `paginate()` for `offset`/`limit` endpoints.
- Typed calls with `AllegroRestClient<paths>` and the type-only `allegro-rest-client/api-types`; `params: { path, query, header }` on every call.
- `allegro-rest-client/testing` (`mockAllegro`).
- Runnable `examples/` (offline by default, sandbox with `LIVE=1`) and `llms.txt`.
- Fixed: crashes on non-JSON or empty bodies, secrets in the token request URL, `redirect_uri=undefined`.
