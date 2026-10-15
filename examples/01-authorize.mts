/**
 * Authorization: the three ways to get tokens.
 *
 *   node examples/01-authorize.mts                              offline, fake Allegro, no credentials
 *   LIVE=1 node --env-file=.env examples/01-authorize.mts       real sandbox: asks you to approve the app once
 *
 * 1. device flow  a person approves the app on a verification page (preferred for tools and servers)
 * 2. web flow     users log in through your site and Allegro redirects back with a `code`
 * 3. app token    `client_credentials`: no user, only the ~12 reference-data endpoints (categories, carriers, ...)
 *
 * Tokens are stored through `options.storage` (default: memory) and refreshed automatically when less than
 * `refreshThresholdHours` (default 1) of the ~12 h access token remain.
 */
import assert from 'node:assert/strict'
import { connectUnauthorized, LIVE, offlineOnly, section, show } from './_client.mts'

const tokenReply = (extra = {}) => ({
  body: {
    access_token: 'access-1',
    refresh_token: 'refresh-1',
    token_type: 'bearer',
    expires_in: 43198,
    scope: 'allegro:api:profile:read',
    jti: 'j1',
    ...extra,
  },
})

let polls = 0
const { client, mode } = await connectUnauthorized(
  {
    'POST /auth/oauth/device': {
      body: {
        device_code: 'dc-1',
        user_code: 'ABCD',
        expires_in: 3600,
        interval: 5,
        verification_uri: 'https://allegro.pl.allegrosandbox.pl/auth/oauth/device',
        verification_uri_complete: 'https://allegro.pl.allegrosandbox.pl/auth/oauth/device?code=ABCD',
      },
    },
    // the user "approves" on the third poll
    'POST /auth/oauth/token': () =>
      ++polls < 3 ? { status: 400, body: { error: 'authorization_pending' } } : tokenReply(),
    'GET /me': { body: { id: '1', login: 'sandbox-user' } },
  },
  {},
  { url_redirect: 'https://shop.example/allegro/callback' },
)
console.log(`mode: ${mode}`)

section('1. device flow: bindApp() + pollDevice()')
const device = await client.bindApp!() // undefined for config.type 'web'
show('open this URL', device.verification_uri_complete)
// pollDevice waits `interval` seconds between polls, backs off on `slow_down`, and stops at `expires_in`
// or when you pass { signal }. Pass `sleep` in the client options to control the waiting (tests do).
const tokens = await client.pollDevice(device)
show('access token valid for (s)', tokens.expires_in)
show('hours left', client.getExpiresInHours())
offlineOnly(() => assert.equal(polls, 3))

section('2. web flow: getAuthorizationUrl() + authorize(code)')
// needs `url_redirect` in the config. `state` must be unguessable and checked when the user comes back.
const url = new URL(client.getAuthorizationUrl({ state: 'a-random-value', scope: ['allegro:api:profile:read'] }))
show('send the user to', `${url.origin}${url.pathname}`)
show('query', Object.fromEntries(url.searchParams))
// later, in your redirect handler:  await client.authorize(req.query.code)

section('3. application token: authorizeApp()')
if (LIVE) {
  console.log('   (skipped live: it would replace the user token in this account)')
} else {
  const app = await client.authorizeApp() // grant_type=client_credentials, no refresh token
  show('application token marked', app.grant)
  // it is re-requested automatically before it expires. It replaces whatever the storage `account` holds, so
  // use `account: 'app'` in the client options if the same storage also holds a user's tokens.
}
