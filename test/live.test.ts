import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AllegroRestClient } from '../src'

// Opt-in: talks to the Allegro sandbox. Run with
//   ALLEGRO_LIVE=1 ALLEGRO_CLIENT_ID=... ALLEGRO_CLIENT_SECRET=... ALLEGRO_URL_REDIRECT=... npm test
const live = process.env.ALLEGRO_LIVE === '1'
const config = {
  app_name: 'live-test',
  type: 'web',
  client_id: process.env.ALLEGRO_CLIENT_ID ?? '',
  client_secret: process.env.ALLEGRO_CLIENT_SECRET ?? '',
  url_redirect: process.env.ALLEGRO_URL_REDIRECT,
}

test('live: an invalid authorization code is rejected with invalid_grant', { skip: !live }, async () => {
  const client = await AllegroRestClient(config, { sandbox: true })
  await assert.rejects(client.authorize('invalid_code'), (err: any) => {
    assert.equal(err.error, 'invalid_grant')
    assert.deepEqual(Object.keys(err).sort(), ['error', 'error_description'])
    return true
  })
})

test('live: requests without tokens reject with missing_access_token', { skip: !live }, async () => {
  const client = await AllegroRestClient(config, { sandbox: true, account: 'no-tokens' })
  await assert.rejects(client.get('/sale/offers/123'), { error: 'missing_access_token' })
})
