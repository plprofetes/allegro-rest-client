import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AllegroRestClient } from '../src'
import { githubVariableStorage } from './ci/storage'

// Opt-in: read-only checks with a real sandbox USER token that the scheduled workflow (user-token.yml) keeps alive in
// an encrypted repository variable. Run it only after the `refresh` step, so the access token is fresh.
const live = process.env.ALLEGRO_USER_LIVE === '1'

const client = () =>
  AllegroRestClient(
    {
      app_name: 'ci',
      type: 'device',
      client_id: process.env.ALLEGRO_CLIENT_ID!,
      client_secret: process.env.ALLEGRO_CLIENT_SECRET!,
    },
    {
      sandbox: true,
      account: 'ci',
      userAgent: 'allegro-rest-client-ci (+https://github.com/plprofetes/allegro-rest-client)',
      storage: githubVariableStorage({
        repo: process.env.GITHUB_REPOSITORY!,
        name: process.env.ALLEGRO_STATE_VARIABLE ?? 'ALLEGRO_USER_TOKENS',
        token: process.env.CI_STATE_PAT!,
        passphrase: process.env.ALLEGRO_STATE_KEY!,
      }),
    },
  )

test('live user: /me answers for the stored user token', { skip: !live }, async () => {
  const me = await (await client()).get<{ id: string }>('/me')
  assert.equal(typeof me.id, 'string')
})

test('live user: reference data and a seller endpoint are reachable', { skip: !live }, async () => {
  const c = await client()
  const categories = await c.get<{ categories: unknown[] }>('/sale/categories')
  assert.ok(categories.categories.length > 0)
  // an account that is not verified as a seller gets an Allegro error here, which still proves the token is accepted
  const offers = await c.get('/sale/offers', { qs: { limit: 1 } }).catch((e: unknown) => e)
  const rejectedAsAuth = (offers as { error?: string } | null)?.error === 'invalid_token'
  assert.ok(!rejectedAsAuth, 'the user token was rejected')
})

test('live user: paginate walks a user endpoint without auth errors', { skip: !live }, async () => {
  const c = await client()
  const seen: unknown[] = []
  try {
    for await (const offer of c.paginate('/sale/offers', { qs: { limit: 5 }, maxItems: 7 })) seen.push(offer)
  } catch (e) {
    assert.ok((e as { errors?: unknown }).errors, `unexpected failure: ${JSON.stringify(e)}`) // Allegro error body is fine
  }
  assert.ok(seen.length <= 7)
})
