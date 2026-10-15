/**
 * Making requests: methods, query strings, bodies, path templates, typed calls.
 *
 *   node examples/02-requests.mts                         offline
 *   LIVE=1 node --env-file=.env examples/02-requests.mts  sandbox, read-only parts only
 *
 * Every call resolves to the parsed JSON body and rejects with Allegro's error (see 06-errors.mts).
 * The client adds `Authorization: Bearer ...` and `Accept: application/vnd.allegro.public.v1+json` itself.
 */
import assert from 'node:assert/strict'
import type { paths } from 'allegro-rest-client/api-types' // type-only: nothing is loaded at runtime
import { connect, LIVE, offlineOnly, section, show, wire } from './_client.mts'

const { client, calls } = await connect<paths>({
  'GET /me': { body: { id: '123', login: 'sandbox-user' } },
  'GET /sale/categories': { body: { categories: [{ id: '1', name: 'Dom i Ogród', leaf: false }] } },
  'GET /sale/product-offers/abc%2F1': { body: { id: 'abc/1', name: 'Mug' } },
  'POST /sale/offer-publication-commands/cmd-1': { status: 201, body: { id: 'cmd-1' } },
  'PUT /sale/offers/42': { body: { ok: true } },
  'PATCH /sale/offers/42': { body: { id: '42' } },
  'DELETE /sale/offers/42': { status: 204 },
})

section('GET with a typed response (client is AllegroRestClient<paths>)')
const me = await client.get('/me') // `me` is typed from the specification: me.id, me.login, ...
show('seller id', me.id)

section('GET with query parameters, typed against the endpoint')
// With `paths`, only real paths are accepted and unknown query parameters are compile errors:
//   client.get('/sale/categoriez')                                  -> error: not a path
//   client.get('/sale/categories', { params: { query: { x: 1 } } }) -> error: unknown query parameter
const { categories } = await client.get('/sale/categories', { params: { query: { 'parent.id': '1' } } })
show(
  'categories',
  categories?.map((c) => c.name),
)

section('Path templates are filled and URL-encoded for you')
const offer = await client.get('/sale/product-offers/{offerId}', { params: { path: { offerId: 'abc/1' } } })
show('offer', offer)
offlineOnly(() => assert.ok(calls.at(-1)!.url.endsWith('/sale/product-offers/abc%2F1')))

if (!LIVE) {
  // Writes would change a real account, so they only run against the fake.
  const plain = await client.request<any>('/sale/offer-publication-commands/cmd-1', {
    method: 'POST',
    json: { offerCriteria: [{ type: 'CONTAINS_OFFERS', offers: [{ id: '42' }] }] },
  })
  section('json: serialised, and Content-Type defaults to the vendor type (Allegro answers 415 for application/json)')
  show('answer', plain)
  show('on the wire', wire(calls.at(-1)!))

  section('request() is always untyped: use it for endpoints the specification lacks, or any method by name')
  await client.request('/sale/offers/42', { method: 'PUT', form: { a: '1', b: 'two' } }) // application/x-www-form-urlencoded
  show('form body', calls.at(-1)!.body)
  await client.request('/sale/offers/42', { method: 'PATCH', json: { stock: { available: 3 } } })
  const removed = await client.request('/sale/offers/42', { method: 'DELETE' })
  show('DELETE -> 204 resolves to', removed === '' ? '"" (empty body)' : String(removed))
}
