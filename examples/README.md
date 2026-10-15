# Examples

Runnable, self-checking samples of `allegro-rest-client`. Each file is short, heavily commented, prints what it is doing, and asserts what it claims.

```sh
npm ci && npm run build        # the examples import the package by name, which resolves to dist/
node examples/04-pagination.mts
npm run examples               # build, type-check and run all of them offline (this is what CI does)
```

Needs Node 22.18+ (it runs `.mts` files directly by stripping the types). On Node 22.6 to 22.17 add `--experimental-strip-types`.

## Two modes

|             | offline (default)                                 | `LIVE=1`                                                                                          |
| ----------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| talks to    | a fake Allegro from `allegro-rest-client/testing` | the real Allegro **sandbox**                                                                      |
| needs       | nothing                                           | `ALLEGRO_CLIENT_ID` and `ALLEGRO_CLIENT_SECRET` of a sandbox _device_ application, e.g. in `.env` |
| run         | `node examples/NN-name.mts`                       | `LIVE=1 node --env-file=.env examples/NN-name.mts`                                                |
| first login | not needed                                        | prints a URL to approve once; tokens are cached in `.allegro-tokens.json` (git-ignored)           |
| writes      | allowed (nothing real happens)                    | never: examples that write run offline only                                                       |

Live mode is not run by CI; offline mode is, so the code in the examples is known to work, and the live parts are read-only calls that use the same API.

## Index

| File                                                         | Shows                                                                                                  | Live         |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ | ------------ |
| [01-authorize.mts](01-authorize.mts)                         | device flow (`bindApp`, `pollDevice`), web flow (`getAuthorizationUrl`, `authorize`), `authorizeApp()` | device flow  |
| [02-requests.mts](02-requests.mts)                           | get/post/put/patch/delete, `qs`, `json`, `form`, path templates, typed calls with `paths`              | reads        |
| [03-headers.mts](03-headers.mts)                             | `userAgent`, `defaultHeaders`, per-request headers, Accept and Content-Type rules                      | one 422      |
| [04-pagination.mts](04-pagination.mts)                       | `paginate()`: offset/limit, `maxItems`, `itemsKey`, `cursor: true`                                     | reads        |
| [05-uploads-and-downloads.mts](05-uploads-and-downloads.mts) | `host: 'upload'`, binary bodies, `raw: true` downloads                                                 | offline only |
| [06-errors.mts](06-errors.mts)                               | plain errors, `errorMode: 'class'`, `trace-id`, transport errors, type guards                          | a real 422   |
| [07-retries-and-policies.mts](07-retries-and-policies.mts)   | `retry429Policy`, `transientRetryPolicy`, a custom policy, per-request policy                          | offline only |
| [08-hooks-and-logging.mts](08-hooks-and-logging.mts)         | `hooks` for metrics, a pino-style `logger`                                                             | reads        |
| [09-storage-and-refresh.mts](09-storage-and-refresh.mts)     | `TokenStorage`, refresh threshold, single-use refresh tokens, injected clock                           | offline only |
| [10-testing-your-code.mts](10-testing-your-code.mts)         | `mockAllegro` with `node:test`                                                                         | offline only |

`_client.mts` is the only shared file. It decides where a client talks to (fake or sandbox); everything interesting is in the numbered files, which use the public API exactly as your code would.

## For LLMs and code generators

- Start from [`llms.txt`](../llms.txt) at the repository root: the API in one page, with the rules that are easy to get wrong.
- Copy from the numbered examples, not from `_client.mts`: in your code you construct the client with `AllegroRestClient(config, options)` as in `09-storage-and-refresh.mts`.
- The examples assert the behaviour their comments describe whenever it can be checked offline, and CI runs them, so they do not rot silently.
