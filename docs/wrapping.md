# Scenarios that need a wrapper (by design)

The library owns the Allegro-specific mechanics: OAuth flows, token refresh, one transport, a policy hook, hooks. It deliberately does **not** own application decisions. In a real deployment (several processes, a database, humans approving logins, alerting) you will put a thin wrapper of your own around the client. This page names the scenarios that belong in that wrapper, so nobody tries to push them into the library, and shows which extension point to use.

The list comes from running a production wrapper against the 1.x client; no code was copied, and nothing here is specific to one deployment.

Status column: **now** = possible with the current API, **P2/P3** = planned in the [roadmap](modernization-plan.md), where the library might take over part of the job.

| #   | Scenario                                              | Why it is wrapper territory                                                                                                                   | Use                                                                                                                                   | Status                                       |
| --- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| 1   | **Sharing one account's tokens across processes**     | Refresh tokens are single use, so two processes refreshing at once break each other. Locking is a property of _your_ database, not of Allegro | `storage` implementation with a lock or compare-and-swap; re-read tokens before refreshing; detect "a sibling refreshed" by timestamp | now (storage contract); P3 `withRefreshLock` |
| 2   | **Picking up tokens another process refreshed**       | The client reads storage once, at creation, and keeps tokens in memory                                                                        | Drop the client and create a new one (cheap) when you learn storage changed                                                           | now; P2 opt-in re-read per request           |
| 3   | **Owning the refresh schedule**                       | When to refresh (e.g. halfway through the TTL, under a lock) is a policy of your deployment                                                   | `refreshThresholdHours: 0` to disable built-in refresh, then refresh through your own code path and `storage.set`                     | now; P3 public `refreshTokens()`             |
| 4   | **Recovering from `invalid_token` / `invalid_grant`** | Whether to retry once (a sibling may have just committed fresh tokens), rebuild the client, or fall back to re-authorization is your call     | Catch the error code at the call site; limit attempts; see the skeleton below                                                         | now; P2 `ctx.refresh()` in policies          |
| 5   | **Re-authorization with a human in the loop**         | Someone has to open `verification_uri_complete`. Delivering that link (chat, ticket, email) and alerting after N failures is your integration | `client.bindApp()` + `client.authorize(device_code)` are single calls; you notify and you poll                                        | now; P2 poller helper (no delivery)          |
| 6   | **Device-flow coordination**                          | With several processes you want exactly one poller, a persisted pending `device_code` (restart-safe), and takeover when the poller dies       | Persist the pending code next to the tokens; poll on `authorization_pending`, double the interval on `slow_down`                      | now; P3 injectable persistence               |
| 7   | **Error budgets and circuit breaking**                | "Stop after 3 failed logins, require manual reset" is operations policy                                                                       | Counters in your storage; map to your own exception                                                                                   | wrapper only                                 |
| 8   | **Translating errors into domain errors**             | The library rejects with Allegro's shapes; your code wants `NotAuthorizedError`, `QuotaExceeded`, etc.                                        | Do it at the call site, or return `{ action: 'throw', error }` from a `policy`                                                        | now                                          |
| 9   | **Layered retries**                                   | If your wrapper already retries transport errors, library-level retries multiply attempts                                                     | Keep the default policy (no retries) and retry in one place; or use the presets and drop yours                                        | now                                          |
| 10  | **Endpoint quirks and batching**                      | Splitting a long date range into 7-day chunks, pausing between calls, merging results, headers an endpoint rejects: all API-specific          | Plain calls to `client.get()` in a domain method                                                                                      | wrapper only                                 |
| 11  | **Application identification**                        | A `User-Agent` (or similar) your organization wants on every call                                                                             | Set it in the wrapper's request helper (`headers`). P2 adds a `defaultHeaders` option                                                 | now; P2                                      |
| 12  | **Context in logs and traces**                        | Request-scoped fields (path, account, trace span) come from your logging/tracing setup                                                        | `hooks` for timing and status; add your context in the wrapper                                                                        | now                                          |
| 13  | **Configuration and secrets**                         | Where credentials live, which environment (sandbox/production), how accounts are named                                                        | A factory function that reads config and builds options                                                                               | wrapper only                                 |
| 14  | **Resource lifecycle**                                | The storage may hold a database connection that must be reconnected or closed                                                                 | A `close()` on your wrapper/storage; the client itself holds nothing to close                                                         | wrapper only                                 |
| 15  | **Domain-typed methods**                              | `me()`, `offers()`, `adsClients()` with response types you maintain, including APIs the public spec does not cover                            | Methods calling `client.get<YourType>()`; P2 brings spec-typed calls and a bring-your-own paths type                                  | now; P2                                      |

## Skeleton

A minimal wrapper showing the usual shape: a cached client, a storage you control, one place for recovery and error translation. Replace the `...` parts with your deployment's logic.

```ts
import {
  AllegroRestClient,
  isAllegroError,
  type AllegroClient,
  type ClientConfig,
  type TokenStorage,
} from 'allegro-rest-client'

export class NotAuthorizedError extends Error {}

export class AllegroGateway {
  private client?: AllegroClient

  constructor(
    private config: ClientConfig,
    private storage: TokenStorage, // scenario 1: your locking / sibling detection lives here
    private sandbox = false,
  ) {}

  private async getClient(): Promise<AllegroClient> {
    // scenario 2: the client reads storage once, so a new client = fresh tokens
    this.client ??= await AllegroRestClient(this.config, {
      sandbox: this.sandbox,
      storage: this.storage,
      refreshThresholdHours: 0, // scenario 3: this wrapper refreshes, see ensureFresh()
    })
    return this.client
  }

  private async ensureFresh(client: AllegroClient): Promise<void> {
    // scenario 3: e.g. take a lock, refresh when fewer than N hours remain, storage.set(), release
  }

  async get<T>(path: string, retried = false): Promise<T> {
    try {
      const client = await this.getClient()
      await this.ensureFresh(client)
      return await client.get<T>(path)
    } catch (e) {
      if (isAllegroError(e) && 'error' in e) {
        if (!retried && (e.error === 'invalid_token' || e.error === 'invalid_grant')) {
          this.client = undefined // scenario 4: rebuild from storage, retry once
          return this.get<T>(path, true)
        }
        if (e.error === 'missing_access_token') throw new NotAuthorizedError('authorize first') // scenarios 5, 8
      }
      throw e
    }
  }
}
```

## When something should move into the library

A scenario graduates from this page to the library when (a) two independent deployments need the same code and (b) it can be expressed without knowing your database, your alerting, or your people. Candidates already on the roadmap: a device-flow poller with injectable persistence and sleep, a `withRefreshLock(fn)` storage hook, a policy-level `refresh()`, `defaultHeaders`, and a public `refreshTokens()`.
