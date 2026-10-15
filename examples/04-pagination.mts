/**
 * Pagination: `paginate()` is an async generator that fetches one page per request.
 *
 *   node examples/04-pagination.mts                         offline
 *   LIVE=1 node --env-file=.env examples/04-pagination.mts  sandbox, read-only (cursor part uses real product data)
 *
 * Two styles exist in Allegro's API:
 *   offset/limit  38 operations, e.g. /sale/offers, /order/checkout-forms   -> default
 *   cursor        `nextPage.id` in the response, `page.id` in the query     -> { cursor: true }
 * Event feeds that continue from the last event id (`from`) are not covered: loop with client.get().
 */
import assert from 'node:assert/strict'
import { connect, LIVE, offlineOnly, section, show } from './_client.mts'

const offers = Array.from({ length: 5 }, (_, i) => ({ id: `offer-${i + 1}` }))
const products = [['p1', 'p2'], ['p3', 'p4'], ['p5']]

const { client, calls } = await connect({
  // offset/limit: answer from the query like the real API does
  'GET /sale/offers': (req) => {
    const offset = Number(req.query.get('offset'))
    const limit = Number(req.query.get('limit'))
    const page = offers.slice(offset, offset + limit)
    return { body: { offers: page, count: page.length, totalCount: offers.length } }
  },
  // cursor: the response names the next page; the last page has no `nextPage`
  'GET /sale/products': (req) => {
    const at = Number(req.query.get('page.id') ?? 0)
    return {
      body: {
        products: products[at].map((id) => ({ id })),
        filters: [], // a second array: that is why itemsKey is needed below
        ...(at + 1 < products.length ? { nextPage: { id: String(at + 1) } } : {}),
      },
    }
  },
})

section('offset/limit: all items, 2 per request (qs, headers and other options are sent with every page)')
const seen: string[] = []
for await (const offer of client.paginate<{ id: string }>('/sale/offers', { qs: { limit: 2 } })) seen.push(offer.id)
show('items', seen)
show('requests made', calls.length)
// it stops at the first page that is shorter than `limit`; the items are taken from the response's only array
offlineOnly(() =>
  assert.deepEqual(
    seen,
    offers.map((o) => o.id),
  ),
)

section('maxItems stops early (no extra request after the last needed item)')
const first3: string[] = []
for await (const offer of client.paginate<{ id: string }>('/sale/offers', { qs: { limit: 2 }, maxItems: 3 }))
  first3.push(offer.id)
show('items', first3)

section('cursor: /sale/products, itemsKey because the response has two arrays')
const ids: string[] = []
for await (const product of client.paginate<{ id: string }>('/sale/products', {
  cursor: true,
  itemsKey: 'products',
  qs: { phrase: 'laptop' },
  headers: { 'Accept-Language': 'pl-PL' }, // this endpoint answers 422 without a supported language
  maxItems: LIVE ? 45 : Infinity, // live there are thousands of products
})) {
  ids.push(product.id)
}
show('items', LIVE ? `${ids.length} products, ${new Set(ids).size} distinct` : ids)

section('Allegro limits how deep you can page')
console.log('   /order/checkout-forms answers TooLargeMaxResultWindowException above offset+limit 10000.')
console.log('   The error reaches you unchanged; narrow the filters (dates, status) instead of paging deeper.')
