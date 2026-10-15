# allegro-rest-client

A small, dependency-free client for the [Allegro REST API](https://developer.allegro.pl/documentation/). It handles the OAuth token lifecycle (device and web flows, storage, refresh) and gives you `get/post/put/patch/delete` that always carry a valid token. Retry, logging and token-storage decisions are yours: they are injected, and the defaults are simple.

- Node **22+**, zero runtime dependencies, native `fetch`
- Works with CommonJS and ESM; ships its own types
- Docs: [what to wrap around it](docs/wrapping.md) · [runbooks](docs/runbooks.md) · [roadmap](docs/modernization-plan.md)

> The library uses the global `fetch`, `Response`, `AbortSignal` types. TypeScript projects need `@types/node` (or the DOM lib).

## Install

```sh
npm install allegro-rest-client
```

Register an application first: [production](https://apps.developer.allegro.pl) or [sandbox](https://apps.developer.allegro.pl.allegrosandbox.pl). Two app types exist:

- **device** (preferred): you open a URL, approve the app, and exchange the `device_code` for tokens.
- **web**: Allegro redirects to your `url_redirect` with a `code`, which you exchange for tokens.

## Quick start (device app)

```ts
import { AllegroRestClient } from 'allegro-rest-client'

const client = await AllegroRestClient(
  {
    app_name: 'my-app',
    type: 'device',
    client_id: process.env.ALLEGRO_CLIENT_ID!,
    client_secret: process.env.ALLEGRO_CLIENT_SECRET!,
  },
  { sandbox: true, storage: myTokenStorage }, // storage is optional, see "Token storage"
)

if (client.getExpiresInHours() === '0.00') {
  // not authorized yet
  const device = await client.bindApp!()
  console.log('Approve the app at', device.verification_uri_complete)
  // waits until the user approves (honours interval and slow_down); pass { signal } to cancel
  await client.pollDevice(device)
}

const { categories } = await client.get('/sale/categories')
```

For a **web** app, send the user to `client.getAuthorizationUrl({ state })` (needs `url_redirect`; verify `state` when they return), then call `client.authorize(code)` with the `code` Allegro appends to your redirect URL. `bindApp` is `undefined` for web apps. Without `pollDevice` you can loop on `client.authorize(device_code)` yourself; it rejects with `{ error: 'authorization_pending' }` until approved.

For **reference data without a user** (categories, delivery methods, carriers; about 12 operations), call `await client.authorizeApp()` (`client_credentials`). The application token lasts about 12 hours and is requested again automatically when it runs low. It replaces whatever tokens the `account` holds, so give it its own `account` if the same storage also holds a user's tokens.

Runnable samples (offline by default, sandbox with `LIVE=1`): [examples/](examples/README.md). One-page API summary for tools and LLMs: [llms.txt](llms.txt). More: [recipes](docs/recipes.md) (quickstart per auth flow, 429, several accounts) and [storage recipes](docs/storage-recipes.md).

## Making requests

```ts
const me = await client.get('/me')
const offers = await client.get('/sale/offers', { qs: { limit: 20, 'publication.status': ['ACTIVE', 'INACTIVE'] } })
const created = await client.post('/sale/product-offers', { json: offerPayload }) // payload as documented by Allegro
await client.patch(`/sale/product-offers/${offerId}`, { json: changes })
// endpoints documented as beta need their own Accept header
await client.get('/sale/user-ratings', { headers: { Accept: 'application/vnd.allegro.beta.v1+json' } })

// type the response yourself
const { id } = await client.get<{ id: string }>('/me')
```

Defaults: `Authorization: Bearer <token>` and `Accept: application/vnd.allegro.public.v1+json`; pass `headers` to override either. The token is refreshed automatically when less than an hour remains.

### Uploads and binary data

Images and attachments are served from a different host. Choose it per request:

```ts
await client.post('/sale/images', { host: 'upload', body: pngBytes, headers: { 'Content-Type': 'image/png' } })

// binary downloads: get the native Response, read it as you like
// binary endpoints: set Accept to the media type the specification lists for that response
const res = await client.post<Response>('/shipment-management/label', {
  json: labelRequest,
  raw: true,
  headers: { Accept: 'application/octet-stream' },
})
const pdf = Buffer.from(await res.arrayBuffer())
```

`body` accepts a string, `Buffer`/`Uint8Array`, `Blob`, `FormData`, `URLSearchParams` or a stream. Absolute URLs are accepted only for the active environment's Allegro hosts, so the token cannot be sent anywhere else.

### Request options

| Option    | Meaning                                                                               |
| --------- | ------------------------------------------------------------------------------------- |
| `method`  | HTTP method (the shortcuts set it for you)                                            |
| `headers` | Extra/override headers (case-insensitive)                                             |
| `qs`      | Query string. Arrays repeat the key (`a=1&a=2`); nested objects are rejected          |
| `body`    | See above. Strings are sent without an implicit content type                          |
| `json`    | Object/array sent as JSON; content type defaults to the `Accept` media type           |
| `form`    | Sent as `application/x-www-form-urlencoded`                                           |
| `timeout` | Abort after this many milliseconds                                                    |
| `signal`  | An `AbortSignal` to cancel from outside                                               |
| `host`    | `'api'` (default) or `'upload'`                                                       |
| `raw`     | Return the native `Response` instead of parsed JSON                                   |
| `policy`  | Override the client's [response policy](#retries-and-error-handling) for this request |

Use only one of `body`, `json`, `form`.

### Things Allegro is picky about

Observed on the sandbox (details and the rest in [docs/allegro-conventions.md](docs/allegro-conventions.md)): `Accept` must be Allegro's vendor type, since `application/json` and `*/*` get **406**; writes need the vendor `Content-Type` (`application/json` gets **415**, which is why `json` defaults to the vendor type); unknown query parameters are silently ignored; and every API response carries a `trace-id` header worth quoting to support (`err.headers.get('trace-id')`).

### Paginating

```ts
for await (const offer of client.paginate('/sale/offers', { qs: { limit: 100, 'publication.status': 'ACTIVE' } })) {
  // one request per page, stops at the last (short) page
}
```

Works for the `offset`/`limit` endpoints (38 of the paginated operations in the spec). The items are taken from the response's only array property; pass `itemsKey` if there are several, and `maxItems` to stop early. Allegro limits how deep you can page: `/order/checkout-forms` answers `TooLargeMaxResultWindowException` when offset plus limit exceed 10000 (seen on the sandbox, 2026-10-15), and that error reaches you unchanged.

Endpoints with a cursor (`nextPage.id` in the response, `page.id` in the query: `/sale/products`, `/sale/bundles`, `/sale/flexible-bundles`) need `cursor: true`, and `/sale/products` also an `itemsKey` because its response has two arrays and a supported `Accept-Language`:

```ts
for await (const product of client.paginate('/sale/products', {
  cursor: true,
  itemsKey: 'products',
  qs: { phrase: 'laptop' },
  headers: { 'Accept-Language': 'pl-PL' },
})) {
}
```

Event feeds that continue from the last event id (`from`) are not covered.

## Client options

```ts
AllegroRestClient(config, options?)
```

`config`: `app_name`, `type` (`'device' | 'web'`), `client_id`, `client_secret`, `url_redirect` (web apps).

| Option                  | Default           | Meaning                                                                                  |
| ----------------------- | ----------------- | ---------------------------------------------------------------------------------------- |
| `sandbox`               | `false`           | Use the Allegro sandbox hosts                                                            |
| `account`               | `'default'`       | Key under which tokens are stored (one client per Allegro account)                       |
| `storage`               | in memory         | Where tokens live, see below                                                             |
| `logger`                | `false`           | `true` logs to the console; or pass a pino-style logger (`debug/info/warn(fields, msg)`) |
| `hooks`                 | none              | Callbacks for logging/metrics, see below                                                 |
| `policy`                | `defaultPolicy`   | Decides what happens after each response, see below                                      |
| `fetch`                 | global `fetch`    | Your own `fetch` (proxy, keep-alive agent, test double)                                  |
| `refreshThresholdHours` | `1`               | Refresh when fewer hours remain. `0` turns built-in refresh off (you refresh yourself)   |
| `errorMode`             | `'plain'`         | `'class'` rejects with `AllegroApiError` instead of plain objects, see "Errors"          |
| `tokenParams`           | `'form'`          | `'query'` sends OAuth parameters in the URL like 1.x did                                 |
| `defaultHeaders`        | none              | Headers sent on every API and token request (per-request `headers` win)                  |
| `userAgent`             | none              | Shorthand for a default `User-Agent` header                                              |
| `sleep`, `now`          | real timers/clock | Injectable for tests                                                                     |

## Token storage

```ts
interface TokenStorage {
  get(account: string): AuthResponse | null | undefined | Promise<...>
  set(account: string, tokens: AuthResponse): unknown | Promise<unknown>
}
```

Plug in a file, a database, Redis, anything ([recipes with a locking example](docs/storage-recipes.md)). The contract: `get` is called **once, when the client is created**; `set` is called after every authorization or refresh. The library keeps the tokens in memory in between.

Allegro refresh tokens are single use, so if several processes share one account, **make `storage` coordinate** (more scenarios in [docs/wrapping.md](docs/wrapping.md)) (a lock or compare-and-swap in your database, re-reading tokens before refreshing). The library does not de-duplicate refreshes across processes. If you prefer to own refresh completely, set `refreshThresholdHours: 0`.

## Errors

Every failure is a rejected promise with a plain object (not an `Error` instance), in one of these shapes:

| Shape                                         | When                                                                                     |
| --------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `{ error, error_description }`                | OAuth errors (`invalid_grant`, `authorization_pending`, ...) and library errors          |
| `{ errors: [{ code, message, ... }] }`        | Allegro API errors, passed through as received                                           |
| `{ error: 'request_err', error_description }` | Network failure, timeout or abort; `error_description` is the underlying error (`.code`) |
| `{ error: 'http_error', ... }`                | Non-2xx response that was not an Allegro error body                                      |
| `{ error: 'invalid_response', ... }`          | A 2xx response that was not JSON (use `raw: true` for those)                             |

HTTP details are on non-enumerable properties of the error, so `Object.keys(err)` and `JSON.stringify(err)` stay clean: `err.status`, `err.headers` (a `Headers`), `err.body` (text). Note they disappear if you spread or structured-clone the error.

Helpers: `isAllegroError(err)`, `isTransportError(err)`.

**`errorMode: 'class'`** (opt-in) makes the same failures reject with an `AllegroApiError`, a real `Error` with a stack and the same fields (`error`, `error_description`, `errors`) plus `status`, `headers`, `body` and `requestId` (Allegro's `trace-id`, worth quoting to support). `message` is readable (`ERROR: Product not found`). Errors your own policy throws are passed through untouched, and `isAllegroError` accepts both forms.

A table of codes and what to check is in the [runbooks](docs/runbooks.md#debug-a-failing-request-or-login).

## Retries and error handling

After every response (or network failure) a **policy** function decides: return the result, retry after a delay, or throw an error of your choosing. The default policy never retries and produces the errors above. Two ready-made policies are provided and compose through `next`:

```ts
import { AllegroRestClient, retry429Policy, transientRetryPolicy } from 'allegro-rest-client'

const client = await AllegroRestClient(config, {
  // retry 429 (honours Retry-After), then fall back to gateway/network retries for idempotent calls
  policy: retry429Policy({ maxAttempts: 4, next: transientRetryPolicy() }),
})
```

- `retry429Policy`: retries HTTP 429 for API calls; waits for `Retry-After` (seconds or date), otherwise exponential backoff with jitter; capped by `maxDelayMs`.
- `transientRetryPolicy`: retries network errors and 502/503/504, only for idempotent methods (never POST/PATCH unless you list them in `methods`).
- Requests with a stream body and requests you aborted are never retried.

Write your own:

```ts
import { defaultPolicy, type ResponsePolicy } from 'allegro-rest-client'

const policy: ResponsePolicy = (ctx) => {
  // ctx: { request: { method, url, kind: 'api' | 'token', idempotent, ... }, attempt, response?, body?, json?, error? }
  if (ctx.response?.status === 429) return { action: 'throw', error: new MyQuotaError() }
  if (ctx.response?.status === 503 && ctx.attempt < 5) return { action: 'retry', delayMs: 2000 * ctx.attempt }
  return defaultPolicy(ctx) // everything else as usual
}
```

A policy can also be given per request (`{ policy }` option).

## Logging and metrics

`logger: true` is a console shortcut; `logger: pino()` (any object with `debug/info/warn(fields, message)`) gets the same events as structured records, without credentials. For metrics and tracing, use hooks. They receive method, URL, kind, attempt, status, duration and the request id header when Allegro sends one; they never receive credentials, and an exception inside a hook cannot break a request.

```ts
hooks: {
  onRequest: (e) => log.debug({ ...e }, 'allegro request'),
  onResponse: (e) => metrics.timing('allegro', e.durationMs, { status: e.status }),
  onError: (e) => log.warn({ ...e }, 'allegro transport error'),
  onRetry: (e) => log.warn({ ...e }, 'allegro retry'),
}
```

## Testing your code

`allegro-rest-client/testing` gives you a fake Allegro without network access or credentials:

```ts
import { mockAllegro } from 'allegro-rest-client/testing'

const mock = mockAllegro({
  'GET /sale/offers': { body: { offers: [{ id: '1' }], count: 1 } },
  'POST /sale/product-offers': (req) => ({ status: 201, body: { received: req.body } }),
})
const client = await mock.client() // already authorized; pass client options as the first argument
// ... run your code with `client`, then:
mock.calls // every request: method, path, query, headers, body
```

Routes are `'METHOD /path'` (no host, no query); a reply is `{ status?, body?, headers? }` or a function returning one. Any other request answers 404 with `MOCK_ROUTE_MISSING`, so a missing route fails loudly. Use `mock.fetch` if you build the client yourself.

## Types from the official API specification

The package ships types generated from Allegro's OpenAPI specification as a type-only entry point. They are opt-in, so the 1.4 MB file is only loaded by projects that import it:

```ts
import { AllegroRestClient } from 'allegro-rest-client'
import type { paths } from 'allegro-rest-client/api-types'

const client = await AllegroRestClient<paths>(config)
const offer = await client.get('/sale/product-offers/{offerId}', { params: { path: { offerId } } }) // typed response
const { offers } = await client.get('/sale/offers', { params: { query: { limit: 10 } } }) // typed query
```

With `paths`, only paths of the specification are accepted for the method (a typo or `post('/me')` is a compile error), path parameters are required, and `json` is typed from the request body. `params` is `{ path, query, header }`; path values are URL-encoded. Responses are typed as the 2xx bodies (the type also covers every media type of the operation). Endpoints the specification lacks: pass your own `paths`-shaped interface, or use `client.request()`, which is always untyped. Without the type argument nothing changes (`params` still works, untyped).

The types are only as accurate as the specification (this library cannot check them against live responses), so treat them as help, not proof. Binary endpoints still need `raw: true` and an explicit `Accept`.

- **Documentation retrieved: 2026-10-15** from <https://developer.allegro.pl/swagger.yaml> (recorded in [`spec/spec.meta.json`](spec/spec.meta.json) together with a checksum).
- The specification is owned by Allegro; the copy is kept so types can be regenerated reproducibly. A test fails if the committed types and the specification disagree, and if the specification file is missing.
- To refresh it, follow the [runbook](docs/runbooks.md#refresh-the-allegro-api-spec).

## Upgrading from 1.x

Same factory and methods; the error shapes are unchanged. What changed:

- Node 22+ is required, and only the package root is importable (an `exports` map replaces deep imports).
- `request` is gone. These options still work: `method`, `headers`, `body`, `qs`, `form`, `json`, `timeout`. Options that cannot be mapped (`jar`, `auth`, `proxy`, `agent`, `pool`, `encoding`, `useQuerystring`, `qsStringifyOptions`, `formData`, `multipart`, `uri`, `url`, ...) now reject with `unsupported_option`. `qs` writes arrays as repeated keys; `json: true` no longer crashes (it is ignored).
- OAuth parameters go in the request body, not the URL (`tokenParams: 'query'` restores the old behaviour). `redirect_uri` is only sent when `url_redirect` is configured.
- Non-JSON or empty bodies no longer crash the process or hang the call: they reject (`http_error`, `invalid_response`). Non-2xx responses whose body is not an Allegro error now reject as `http_error`; they used to resolve.
- `request_err`'s `error_description` is the underlying cause (an `Error` with `.code`, as before for network errors; a `TimeoutError`/`AbortError` for timeouts).
- Tokens without `created_at` (for example ones you stored yourself) no longer trigger a refresh on every request; expiry is read from the JWT when possible.
- The default in-memory storage now works as intended; `options` can be omitted.
- Types: `ClientConfig.type` also accepts a plain `string`; `bindApp`/`authorize` resolve to the data types (`DeviceResponse`, `AuthResponse`); the exported `Error` type is kept as an alias of `OAuthError`.

New: `patch`, `host: 'upload'`, `raw`, `signal`/`timeout`, `fetch`, `policy` and presets, `hooks`, `refreshThresholdHours`, `tokenParams`, `defaultHeaders`/`userAgent`, `logger` objects, `errorMode`, `authorizeApp`, `getAuthorizationUrl`, `pollDevice`, `paginate`, typed calls (`AllegroRestClient<paths>`), `allegro-rest-client/testing`.

## Development

```sh
npm ci
npm run lint
npm test          # offline; opt-in live tests are described in the runbooks
npm run build
```

Everything else (refreshing the spec, releasing, debugging, extending) is in [docs/runbooks.md](docs/runbooks.md).

## License

MIT, see [LICENSE](LICENSE).
