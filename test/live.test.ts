import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AllegroRestClient, type ClientConfig, type TokenStorage } from '../src'

// Opt-in: talks to the Allegro SANDBOX with a registered web application. Run with
//   ALLEGRO_LIVE=1 ALLEGRO_CLIENT_ID=... ALLEGRO_CLIENT_SECRET=... ALLEGRO_URL_REDIRECT=https://... npm test
// In CI the values come from repository secrets (see .github/workflows/live.yml).
// None of these tests needs a logged-in user: they check what the real token endpoint answers to bad input,
// which is enough to prove that our requests (form body, redirect_uri, Basic auth) are understood.
const live = process.env.ALLEGRO_LIVE === '1'
const config: ClientConfig = {
  app_name: 'live-test',
  type: 'web',
  client_id: process.env.ALLEGRO_CLIENT_ID ?? '',
  client_secret: process.env.ALLEGRO_CLIENT_SECRET ?? '',
  url_redirect: process.env.ALLEGRO_URL_REDIRECT,
}

test('live: credentials are configured', { skip: !live }, () => {
  assert.ok(config.client_id && config.client_secret, 'set ALLEGRO_CLIENT_ID and ALLEGRO_CLIENT_SECRET')
})

for (const tokenParams of ['form', 'query'] as const) {
  test(
    `live: token endpoint understands ${tokenParams} parameters (invalid code -> invalid_grant)`,
    { skip: !live },
    async () => {
      const client = await AllegroRestClient(config, { sandbox: true, tokenParams })
      await assert.rejects(client.authorize('invalid_code'), (err: any) => {
        assert.deepEqual(Object.keys(err).sort(), ['error', 'error_description'])
        assert.equal(err.error, 'invalid_grant')
        // the server echoes the code it parsed: proof that the parameter arrived
        assert.match(String(err.error_description), /invalid_code/)
        assert.equal(err.status, 400)
        return true
      })
    },
  )
}

test('live: refreshing with a bogus refresh token is rejected as invalid_grant', { skip: !live }, async () => {
  const stale = {
    access_token: 'x.y.z',
    refresh_token: 'bogus-refresh-token',
    token_type: 'bearer',
    expires_in: 43200,
    created_at: 1,
    scope: '',
    jti: '',
  }
  const storage: TokenStorage = { get: () => stale, set: () => undefined }
  const client = await AllegroRestClient(config, { sandbox: true, storage })
  await assert.rejects(client.get('/me'), { error: 'invalid_grant' })
})

test('live: requests without tokens reject with missing_access_token', { skip: !live }, async () => {
  const client = await AllegroRestClient(config, { sandbox: true, account: 'no-tokens' })
  await assert.rejects(client.get('/sale/offers/123'), { error: 'missing_access_token' })
})

test('live: an unauthenticated-looking token is refused by the API as invalid_token', { skip: !live }, async () => {
  const bad = {
    access_token: 'not-a-real-token',
    refresh_token: '',
    token_type: 'bearer',
    expires_in: 43200,
    created_at: Math.floor(Date.now() / 1000),
    scope: '',
    jti: '',
  }
  const client = await AllegroRestClient(config, { sandbox: true, storage: { get: () => bad, set: () => undefined } })
  await assert.rejects(client.get('/me'), (err: any) => {
    assert.equal(err.status, 401)
    assert.ok(err.error || err.errors, 'expected an Allegro error body')
    return true
  })
})
