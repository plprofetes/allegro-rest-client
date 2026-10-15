/**
 * Token storage and refresh: where tokens live, and what happens when they run low.
 *
 *   node examples/09-storage-and-refresh.mts         offline (injects a clock, so a day passes in a millisecond)
 *
 * `storage` has two methods. `get(account)` is called ONCE, when the client is created; `set(account, tokens)` after
 * every authorization or refresh. Allegro refresh tokens are SINGLE USE: each refresh returns a new one, and the
 * old one is dead. So (1) `set` must really persist before you rely on the new tokens, and (2) when several
 * processes share one account, make `storage` coordinate: see docs/storage-recipes.md (SQL, Redis, locking).
 */
import assert from 'node:assert/strict'
import { AllegroRestClient, type AuthResponse, type TokenStorage } from 'allegro-rest-client'
import { mockAllegro } from 'allegro-rest-client/testing'
import { section, show } from './_client.mts'

// A storage that logs what it is asked, to make the contract visible. Swap the Map for a file, SQL or Redis.
const saved = new Map<string, AuthResponse>()
const storage: TokenStorage = {
  get(account) {
    console.log(`   storage.get("${account}")`)
    return saved.get(account)
  },
  set(account, tokens) {
    console.log(`   storage.set("${account}") <- refresh token ...${tokens.refresh_token.slice(-3)}`)
    saved.set(account, tokens)
  },
}

let generation = 1
const mock = mockAllegro({
  'POST /auth/oauth/token': () => {
    generation++
    return {
      body: {
        access_token: `access-${generation}`,
        refresh_token: `refresh-${generation}`,
        token_type: 'bearer',
        expires_in: 43200,
        scope: 'allegro:api:profile:read',
        jti: `j${generation}`,
      },
    }
  },
  'GET /me': { body: { id: '1' } },
})

// tokens obtained "now" and valid for 12 hours
let clock = Date.UTC(2026, 9, 15, 8, 0, 0)
saved.set('shop-a', {
  access_token: 'access-1',
  refresh_token: 'refresh-1',
  token_type: 'bearer',
  expires_in: 43200,
  created_at: clock / 1000,
  scope: 'allegro:api:profile:read',
  jti: 'j1',
})

section('create the client: storage.get is called once')
const client = await AllegroRestClient(
  { app_name: 'shop', type: 'device', client_id: 'id', client_secret: 'secret' },
  {
    account: 'shop-a', // one account per Allegro seller; the storage key
    storage,
    fetch: mock.fetch,
    now: () => clock, // injectable clock, for tests (and this example)
    refreshThresholdHours: 1, // default; 0 disables built-in refresh so you can own it (locking in your DB)
  },
)
show('hours left', client.getExpiresInHours())

section('3 hours later: still fine, no refresh')
clock += 3 * 3600_000
await client.get('/me')
show('token requests so far', mock.calls.filter((c) => c.path === '/auth/oauth/token').length)

section('11.5 hours later: under the threshold, so the next call refreshes FIRST and stores the new pair')
clock += 8.5 * 3600_000
await client.get('/me')
const refresh = mock.calls.find((c) => c.path === '/auth/oauth/token')!
show('refresh request body', refresh.body!.replace(/refresh_token=[^&]+/, 'refresh_token=<single-use token>'))
show(
  'used on the API call',
  mock.calls
    .at(-1)!
    .headers.get('authorization')!
    .replace(/Bearer (.{6}).*/, 'Bearer $1...'),
)
assert.equal(saved.get('shop-a')!.refresh_token, 'refresh-2')

section('a second client on the same storage starts from the stored (new) tokens')
const again = await AllegroRestClient(
  { app_name: 'shop', type: 'device', client_id: 'id', client_secret: 'secret' },
  { account: 'shop-a', storage, fetch: mock.fetch, now: () => clock },
)
show('hours left', again.getExpiresInHours())
console.log(
  '   (two live clients refreshing the SAME account at once would race for the single-use token: lock in storage)',
)
