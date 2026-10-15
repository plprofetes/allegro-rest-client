import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AllegroRestClient } from '../src'
import type { paths } from '../src/generated/api'
import { githubVariableStorage } from './ci/storage'

// Opt-in: read-only checks with a real sandbox USER token that the scheduled workflow (user-token.yml) keeps alive in
// an encrypted repository variable. Run it only after the `refresh` step, so the access token is fresh.
const live = process.env.ALLEGRO_USER_LIVE === '1'

const make = <P extends object = object>() =>
  AllegroRestClient<P>(
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

const client = () => make()
const typedClient = () => make<paths>()

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

// Exploration, not assertions: prints the SHAPE of what the sandbox answers (key names, array lengths, counts), never
// values, because the job log is public. Used to decide which assertions are safe to add. Fails only when the token is
// rejected.
const shape = (value: unknown): string => {
  if (Array.isArray(value)) return `array[${value.length}]`
  if (value === null || typeof value !== 'object') return typeof value
  return Object.entries(value)
    .map(([k, v]) =>
      Array.isArray(v) ? `${k}[${v.length}]` : ['count', 'totalCount'].includes(k) ? `${k}=${String(v)}` : k,
    )
    .sort()
    .join(' ')
}

test('live user: probe response shapes', { skip: !live }, async () => {
  const c = await typedClient()
  const probe = async (name: string, call: () => Promise<unknown>): Promise<unknown> => {
    try {
      const body = await call()
      console.log(`PROBE ${name}: ok ${shape(body)}`)
      return body
    } catch (e) {
      const err = e as { error?: string; errors?: { code?: string; message?: string }[]; status?: number }
      assert.notEqual(err.error, 'invalid_token', `${name}: the user token was rejected`)
      console.log(
        `PROBE ${name}: failed status=${err.status} ${err.error ?? ''} ${err.errors?.[0]?.code ?? ''} ${(err.errors?.[0]?.message ?? '').slice(0, 80)}`,
      )
      return undefined
    }
  }
  await probe('GET /me', () => c.get('/me'))
  const offers = (await probe('GET /sale/offers?limit=2', () =>
    c.get('/sale/offers', { params: { query: { limit: 2 } } }),
  )) as { offers?: { id: string }[] } | undefined
  await probe('GET /sale/products?phrase', () => c.get('/sale/products', { params: { query: { phrase: 'iphone' } } }))
  await probe('GET /order/checkout-forms?limit=2', () =>
    c.get('/order/checkout-forms', { params: { query: { limit: 2 } } }),
  )
  await probe('GET /sale/user-ratings?limit=2', () => c.get('/sale/user-ratings', { params: { query: { limit: 2 } } }))
  await probe('GET /after-sales-service-conditions/return-policies', () =>
    c.get('/after-sales-service-conditions/return-policies', { params: { query: { limit: 2 } } }),
  )
  await probe('GET /sale/delivery-methods', () => c.get('/sale/delivery-methods'))
  await probe('GET /billing/billing-entries?limit=2', () =>
    c.get('/billing/billing-entries', { params: { query: { limit: 2 } } }),
  )
  const firstOffer = offers?.offers?.[0]?.id
  if (firstOffer) {
    await probe('GET /sale/product-offers/{id}', () =>
      c.get('/sale/product-offers/{offerId}', { params: { path: { offerId: firstOffer } } }),
    )
  } else {
    console.log('PROBE sale/product-offers/{id}: skipped, the sandbox account has no offers')
  }

  // pagination: pages of 1, then past the end
  const walked: string[] = []
  await probe('paginate /sale/offers limit=1 maxItems=3', async () => {
    for await (const o of c.paginate<{ id: string }>('/sale/offers', { qs: { limit: 1 }, maxItems: 3 }))
      walked.push(typeof o.id)
    return walked
  })
  await probe('GET /sale/offers?offset=100000', () =>
    c.get('/sale/offers', { params: { query: { limit: 1, offset: 100000 } } }),
  )
})
