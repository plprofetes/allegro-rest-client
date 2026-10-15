/**
 * Testing code that uses the client, without network or credentials.
 *
 *   node examples/10-testing-your-code.mts         runs the tests below with node:test
 *
 * `allegro-rest-client/testing` gives you `mockAllegro(routes)`:
 *   - routes are `'METHOD /path'` (no host, no query) -> `{ status?, body?, headers? }` or a function of the request
 *   - `mock.client(options?)` is a client that is already authorized and talks only to the mock
 *   - `mock.calls` records every request (method, path, query, headers, body) for assertions
 *   - a request without a route answers 404 `MOCK_ROUTE_MISSING`, so a forgotten route fails loudly
 *   - `mock.fetch` is the bare fake, for when you build the client yourself
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AllegroClient } from 'allegro-rest-client'
import { mockAllegro } from 'allegro-rest-client/testing'

// The code under test: any function that takes a client. This is why a wrapper should accept the client as a parameter.
async function activeOfferIds(client: AllegroClient): Promise<string[]> {
  const ids: string[] = []
  for await (const offer of client.paginate<{ id: string }>('/sale/offers', {
    qs: { 'publication.status': 'ACTIVE', limit: 2 },
  })) {
    ids.push(offer.id)
  }
  return ids
}

test('collects ids across pages and sends the filter', async () => {
  const all = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  const mock = mockAllegro({
    'GET /sale/offers': (req) => {
      const offset = Number(req.query.get('offset'))
      return { body: { offers: all.slice(offset, offset + 2), count: 2, totalCount: 3 } }
    },
  })
  assert.deepEqual(await activeOfferIds(await mock.client()), ['a', 'b', 'c'])
  assert.equal(mock.calls.length, 2)
  assert.equal(mock.calls[0].query.get('publication.status'), 'ACTIVE')
})

test('Allegro errors reject with the body, so you can test your handling', async () => {
  const mock = mockAllegro({
    'GET /sale/offers': { status: 403, body: { errors: [{ code: 'OfferAccessDeniedException', message: 'no' }] } },
  })
  await assert.rejects(activeOfferIds(await mock.client()), {
    errors: [{ code: 'OfferAccessDeniedException', message: 'no' }],
  })
})

test('a missing route is a loud 404, not a hang', async () => {
  const client = await mockAllegro({}).client()
  const error = await client.get('/me').catch((e) => e)
  assert.equal(error.errors[0].code, 'MOCK_ROUTE_MISSING')
})
