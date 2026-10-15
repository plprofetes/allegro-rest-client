import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mockAllegro } from '../src/testing'

test('mockAllegro serves routes, records calls and answers unknown routes with a clear 404', async () => {
  const mock = mockAllegro({
    'GET /sale/offers': { body: { offers: [{ id: '1' }], count: 1 } },
    'POST /sale/product-offers': (req) => ({ status: 201, body: { echoed: req.body } }),
  })
  const client = await mock.client()
  assert.deepEqual(await client.get('/sale/offers', { qs: { limit: 1 } }), { offers: [{ id: '1' }], count: 1 })
  assert.equal(mock.calls[0].query.get('limit'), '1')
  assert.equal(mock.calls[0].headers.get('authorization'), 'Bearer test-access-token')
  assert.deepEqual(await client.post('/sale/product-offers', { json: { a: 1 } }), { echoed: '{"a":1}' })
  const missing = await client.get('/nope').catch((e) => e)
  assert.equal(missing.errors[0].code, 'MOCK_ROUTE_MISSING')
  assert.match(missing.errors[0].message, /GET \/nope/)
  assert.equal(mock.calls.length, 3)
})
