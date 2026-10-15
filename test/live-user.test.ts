import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AllegroApiError, AllegroRestClient, type ClientOptions } from '../src'
import type { paths } from '../src/generated/api'
import { githubVariableStorage } from './ci/storage'

// Opt-in: read-only checks with a real sandbox USER token that the scheduled workflow (user-token.yml) keeps alive in
// an encrypted repository variable. Run it only after the `refresh` step, so the access token is fresh.
const live = process.env.ALLEGRO_USER_LIVE === '1'

const make = <P extends object = object>(extra: ClientOptions = {}) =>
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
      ...extra,
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

test('live user: /me describes the account', { skip: !live }, async () => {
  const me = await (await client()).get<{ id: string; login: string; baseMarketplace: { id: string } }>('/me')
  assert.equal(typeof me.id, 'string')
  assert.equal(typeof me.login, 'string')
  assert.equal(typeof me.baseMarketplace.id, 'string')
})

test('live user: reference data is non-empty with a user token', { skip: !live }, async () => {
  const c = await typedClient()
  const categories = await c.get('/sale/categories')
  assert.ok((categories.categories?.length ?? 0) > 0)
  const methods = await c.get('/sale/delivery-methods')
  assert.ok(methods.deliveryMethods && methods.deliveryMethods.length > 100) // 584 on 2026-10-15
})

// The sandbox account may have no offers or orders at all (it had none on 2026-10-15), so these check invariants
// that hold for an empty and for a filled account: the lists are well-formed and `paginate` yields exactly
// `totalCount` items when that is small.
for (const [path, key] of [
  ['/sale/offers', 'offers'],
  ['/order/checkout-forms', 'checkoutForms'],
] as const) {
  test(`live user: ${path} is well-formed and paginate yields totalCount items`, { skip: !live }, async () => {
    const c = await client()
    const page = await c.get<Record<string, unknown>>(path, { qs: { limit: 2 } })
    assert.ok(Array.isArray(page[key]), `${key} is an array`)
    assert.equal(typeof page.count, 'number')
    assert.equal(typeof page.totalCount, 'number')
    const total = page.totalCount as number
    if (total > 50) return // too many to walk in a smoke test
    const seen: unknown[] = []
    for await (const item of c.paginate(path, { qs: { limit: 2 }, maxItems: 50 })) seen.push(item)
    assert.equal(seen.length, total)
    // asking beyond the end is not an error. Stay below Allegro's window: /order/checkout-forms refuses offset+limit
    // above 10000 (TooLargeMaxResultWindowException), /sale/offers did not on 2026-10-15
    const beyond = await c.get<Record<string, unknown>>(path, { qs: { limit: 2, offset: total + 10 } })
    assert.deepEqual(beyond[key], [])
  })
}

test('live user: paginate follows the cursor of /sale/products', { skip: !live }, async () => {
  const c = await client()
  const ids = new Set<string>()
  let n = 0
  for await (const product of c.paginate<{ id: string }>('/sale/products', {
    cursor: true,
    itemsKey: 'products',
    qs: { phrase: 'laptop' },
    headers: { 'Accept-Language': 'pl-PL' },
    maxItems: 45,
  })) {
    ids.add(product.id)
    n++
  }
  assert.equal(n, 45, 'a second page was fetched (the first has 30)')
  assert.equal(ids.size, 45, 'no product is repeated across pages')
})

test('live user: getSellerId matches /me and the typed client reads it', { skip: !live }, async () => {
  const c = await typedClient()
  const me = await c.get('/me')
  assert.equal(typeof me.id, 'string')
  assert.equal(c.getSellerId(), me.id)
})

test('live user: errorMode class gives a real Error with status and trace-id', { skip: !live }, async () => {
  const seen: { status: number; requestId?: string }[] = []
  const c = await make({
    errorMode: 'class',
    hooks: { onResponse: (e) => void seen.push({ status: e.status, requestId: e.requestId }) },
  })
  // /sale/products without Accept-Language is a stable 422 (2026-10-15)
  const err = await c.get('/sale/products', { qs: { phrase: 'laptop' } }).catch((e: unknown) => e)
  assert.ok(err instanceof AllegroApiError, 'rejects with AllegroApiError')
  assert.equal(err.status, 422)
  assert.match(err.requestId ?? '', /^[0-9a-f]{8,}$/i, 'trace-id header')
  assert.equal(err.errors?.[0].code, 'UnsupportedLanguageInAcceptLanguageHeader')
  assert.ok(err.stack)
  const ok = seen.find((e) => e.status === 422)
  assert.equal(ok?.requestId, err.requestId, 'hooks report the same trace-id')
})

test('live user: bundles use the same cursor shape (empty account is fine)', { skip: !live }, async () => {
  const c = await client()
  let n = 0
  for await (const bundle of c.paginate('/sale/bundles', { cursor: true, qs: { limit: 5 }, maxItems: 12 })) {
    assert.ok(bundle)
    n++
  }
  assert.ok(n <= 12)
})

const anAuthError = (e: unknown) => ['invalid_token', 'invalid_grant'].includes((e as { error?: string }).error ?? '')

test('live user: other seller endpoints do not reject the token', { skip: !live }, async () => {
  const c = await typedClient()
  for (const [name, call] of [
    ['user-ratings', () => c.get('/sale/user-ratings', { params: { query: { limit: 2 } } })],
    [
      'return-policies',
      () => c.get('/after-sales-service-conditions/return-policies', { params: { query: { limit: 2 } } }),
    ],
    ['billing-entries', () => c.get('/billing/billing-entries', { params: { query: { limit: 2 } } })],
  ] as const) {
    const result = await call().catch((e: unknown) => e)
    assert.ok(!anAuthError(result), `${name}: the user token was rejected`)
  }
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
  const probe = async (name: string, call: () => Promise<unknown>): Promise<void> => {
    try {
      console.log(`PROBE ${name}: ok ${shape(await call())}`)
    } catch (e) {
      const err = e as { error?: string; errors?: { code?: string; message?: string }[]; status?: number }
      assert.ok(!anAuthError(err), `${name}: the user token was rejected`)
      console.log(
        `PROBE ${name}: failed status=${err.status} ${err.error ?? ''} ${err.errors?.[0]?.code ?? ''} ${(err.errors?.[0]?.message ?? '').slice(0, 80)}`,
      )
    }
  }
  // products are paged by a cursor (page.id) and need a supported Accept-Language
  const headers = { 'Accept-Language': 'pl-PL' }
  await probe('GET /sale/products?phrase (pl-PL)', () =>
    c.get('/sale/products', { params: { query: { phrase: 'iphone' }, header: { 'Accept-Language': 'pl-PL' } } }),
  )
  await probe('GET /sale/products?phrase untyped headers', () =>
    c.request('/sale/products', { qs: { phrase: 'laptop' }, headers }),
  )
  await probe('GET /sale/categories/{id}', () =>
    c.get('/sale/categories/{categoryId}', { params: { path: { categoryId: '5' } } }),
  )
  await probe('GET /sale/category-events?limit=2', () =>
    c.get('/sale/category-events', { params: { query: { limit: 2 } } }),
  )
})
