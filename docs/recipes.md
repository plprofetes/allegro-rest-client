# Recipes

Short, copy-and-adapt sketches. They are not compiled by the test suite; the calls they use are covered by it. Already in the README: [uploading an image and downloading a binary label](../README.md#uploads-and-binary-data), [paginating](../README.md#paginating), [typed calls](../README.md#types-from-the-official-api-specification), [testing your code](../README.md#testing-your-code). Token persistence and locking: [storage-recipes.md](storage-recipes.md).

## Quickstart per auth flow

**Device app** (a person approves once): see the README quick start. Use `bindApp()`, show `verification_uri_complete`, then `pollDevice(device)`.

**Web app** (users log in through your site):

```ts
const client = await AllegroRestClient(
  { app_name: 'shop', type: 'web', client_id, client_secret, url_redirect: 'https://shop.example/allegro/callback' },
  { storage },
)

// 1. redirect the user, remembering `state` (e.g. in their session)
const state = crypto.randomUUID()
res.redirect(client.getAuthorizationUrl({ state }))

// 2. in the callback route: check `state`, then trade the code for tokens
if (req.query.state !== state) throw new Error('state mismatch')
await client.authorize(String(req.query.code))
```

**No user, reference data only** (categories, delivery methods, carriers):

```ts
const client = await AllegroRestClient(config, { account: 'app-token' }) // own account: it replaces what the account holds
await client.authorizeApp()
const categories = await client.get('/sale/categories')
```

## Handle 429 (rate limits)

Retries are opt-in. Allegro documents 429 on few operations and the sandbox sends no rate-limit headers (see [allegro-conventions.md](allegro-conventions.md)), so the preset falls back to exponential backoff when `Retry-After` is absent:

```ts
import { AllegroRestClient, retry429Policy, transientRetryPolicy } from 'allegro-rest-client'

const client = await AllegroRestClient(config, {
  policy: retry429Policy({ maxAttempts: 4, next: transientRetryPolicy() }),
})
```

Keep retries in one place: if your own wrapper also retries, attempts multiply ([wrapping.md](wrapping.md) #9).

## Several accounts, one configuration

One client per Allegro account, same credentials and options, tokens kept apart by `account`. A small factory keeps the options in one place and reuses clients:

```ts
import { AllegroRestClient, type AllegroClient, type ClientOptions } from 'allegro-rest-client'

export function accountClients(config: ClientConfig, shared: ClientOptions) {
  const clients = new Map<string, Promise<AllegroClient>>()
  return (account: string) => {
    let client = clients.get(account)
    if (!client) clients.set(account, (client = AllegroRestClient(config, { ...shared, account })))
    return client
  }
}

const forAccount = accountClients(config, { storage, userAgent: 'shop/1.0', policy: retry429Policy() })
const offers = await (await forAccount('seller-a')).get('/sale/offers')
```

A client caches its tokens in memory, so if another process refreshed an account's tokens, drop that entry from the map and create a new client (cheap).
