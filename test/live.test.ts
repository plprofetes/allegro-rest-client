import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AllegroRestClient, type AuthResponse, type ClientConfig } from '../src'

// Opt-in: talks to the Allegro SANDBOX with a registered *device* application. Run with
//   ALLEGRO_LIVE=1 ALLEGRO_CLIENT_ID=... ALLEGRO_CLIENT_SECRET=... npm test
// In CI the values come from repository secrets (see .github/workflows/live.yml).
// No logged-in user is needed: requesting a device code works anonymously, and exchanging it before anybody
// approved it is answered with `authorization_pending`. Together that proves our requests (Basic auth, form or
// query parameters, grant type) are understood by the real token endpoint.
const live = process.env.ALLEGRO_LIVE === '1'
const config: ClientConfig = {
  app_name: 'live-test',
  type: 'device',
  client_id: process.env.ALLEGRO_CLIENT_ID ?? '',
  client_secret: process.env.ALLEGRO_CLIENT_SECRET ?? '',
}

const tokensFor = (extra: Partial<AuthResponse>): AuthResponse => ({
  access_token: 'x.y.z',
  refresh_token: '',
  token_type: 'bearer',
  expires_in: 43200,
  created_at: Math.floor(Date.now() / 1000),
  scope: '',
  jti: '',
  ...extra,
})
const storageWith = (tokens: AuthResponse) => ({ get: () => tokens, set: () => undefined })

test('live: credentials are configured', { skip: !live }, () => {
  assert.ok(config.client_id && config.client_secret, 'set ALLEGRO_CLIENT_ID and ALLEGRO_CLIENT_SECRET')
})

test('live: bindApp returns a device code and a sandbox verification URL', { skip: !live }, async () => {
  const client = await AllegroRestClient(config, { sandbox: true })
  const device = await client.bindApp!()
  assert.equal(typeof device.device_code, 'string')
  assert.equal(typeof device.user_code, 'string')
  assert.equal(typeof device.interval, 'number')
  assert.match(device.verification_uri_complete, /^https:\/\/.*allegrosandbox\.pl/)
})

for (const tokenParams of ['form', 'query'] as const) {
  test(
    `live: token endpoint accepts ${tokenParams} parameters (unapproved device code -> authorization_pending)`,
    { skip: !live },
    async () => {
      const client = await AllegroRestClient(config, { sandbox: true, tokenParams })
      const { device_code } = await client.bindApp!()
      await assert.rejects(client.authorize(device_code), (err: any) => {
        assert.deepEqual(Object.keys(err).sort(), ['error', 'error_description'])
        assert.equal(err.error, 'authorization_pending')
        assert.equal(typeof err.status, 'number')
        return true
      })
    },
  )
}

test('live: an unknown device code is rejected by the token endpoint', { skip: !live }, async () => {
  const client = await AllegroRestClient(config, { sandbox: true })
  await assert.rejects(client.authorize('not-a-device-code'), (err: any) => {
    assert.equal(typeof err.error, 'string')
    assert.notEqual(err.error, 'request_err')
    assert.notEqual(err.error, 'authorization_pending')
    return true
  })
})

test('live: refreshing with a bogus refresh token is rejected as invalid_grant', { skip: !live }, async () => {
  const stale = tokensFor({ refresh_token: 'bogus-refresh-token', created_at: 1 })
  const client = await AllegroRestClient(config, { sandbox: true, storage: storageWith(stale) })
  await assert.rejects(client.get('/me'), { error: 'invalid_grant' })
})

test('live: requests without tokens reject with missing_access_token', { skip: !live }, async () => {
  const client = await AllegroRestClient(config, { sandbox: true, account: 'no-tokens' })
  await assert.rejects(client.get('/sale/offers/123'), { error: 'missing_access_token' })
})

test('live: the API refuses a fake access token with a 401 and an Allegro error body', { skip: !live }, async () => {
  const client = await AllegroRestClient(config, {
    sandbox: true,
    storage: storageWith(tokensFor({ access_token: 'not-a-real-token' })),
  })
  await assert.rejects(client.get('/me'), (err: any) => {
    assert.equal(err.status, 401)
    assert.ok(err.error || err.errors, 'expected an Allegro error body')
    return true
  })
})
