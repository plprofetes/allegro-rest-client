import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { operations, paths } from '../src/generated/api'

// These are compile-time assertions: the build fails when a spec update removes or reshapes what the
// library and its documentation rely on.
type Expect<T extends true> = T
type HasMethod<P extends keyof paths, M extends string> =
  paths[P] extends Record<M, infer Op> ? (Op extends object ? true : false) : false

export type Checks = [
  Expect<HasMethod<'/me', 'get'>>,
  Expect<HasMethod<'/sale/categories', 'get'>>,
  Expect<HasMethod<'/sale/categories/{categoryId}', 'get'>>,
  Expect<HasMethod<'/sale/images', 'post'>>,
  Expect<'meGET' extends keyof operations ? true : false>,
]

test('generated API types expose the operations the library documents', () => {
  const check: Checks = [true, true, true, true, true]
  assert.equal(check.length, 5)
})

import { AllegroRestClient } from '../src'
import { config, json, memoryStorage, mockFetch, tokens } from './helpers'

test('typed client: templated paths, typed params and responses, and the default stays untyped', async () => {
  const { fetch, calls } = mockFetch(() => json({ id: 'seller-1' }))
  const storage = memoryStorage(tokens()).storage
  const typed = await AllegroRestClient<paths>(config, { fetch, storage })

  const me = await typed.get('/me')
  const id: string | undefined = me.id // typed MeResponse
  assert.equal(id, 'seller-1')

  await typed.get('/sale/product-offers/{offerId}', { params: { path: { offerId: 'a/b c' } } })
  assert.equal(calls[1].url, 'https://api.allegro.pl/sale/product-offers/a%2Fb%20c')

  await typed.get('/sale/offers', { params: { query: { limit: 2, offset: 4 } } })
  assert.equal(new URL(calls[2].url).search, '?limit=2&offset=4')

  // @ts-expect-error not a path of the spec
  const typo = typed.get('/sale/ofers')
  // @ts-expect-error the path parameter is required
  const noParams = typed.get('/sale/product-offers/{offerId}')
  // @ts-expect-error unknown query parameter
  const badQuery = typed.get('/sale/offers', { params: { query: { limt: 2 } } })
  // @ts-expect-error /me has no POST
  const wrongMethod = typed.post('/me')
  await Promise.allSettled([typo, noParams, badQuery, wrongMethod])

  const untyped = await AllegroRestClient(config, { fetch, storage })
  await untyped.get('/anything', { params: { query: { a: 1 } } }) // untyped keeps working
})

test('a path placeholder without a value is rejected before any request', async () => {
  const { fetch, calls } = mockFetch(() => json({}))
  const client = await AllegroRestClient(config, { fetch, storage: memoryStorage(tokens()).storage })
  await assert.rejects(client.get('/sale/product-offers/{offerId}'), { error: 'invalid_option' })
  assert.equal(calls.length, 0)
})
