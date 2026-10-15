/**
 * Headers: identifying your app, defaults, per-request overrides, and the Accept / Content-Type rules.
 *
 *   node examples/03-headers.mts                         offline: prints what reached the wire
 *   LIVE=1 node --env-file=.env examples/03-headers.mts  sandbox: a real 422 caused by a missing header
 *
 * Precedence, lowest to highest: the client's own (Accept, Authorization) < userAgent < defaultHeaders < per-request `headers`.
 * Token calls (OAuth) carry userAgent/defaultHeaders too, but their Authorization and Content-Type are fixed.
 */
import assert from 'node:assert/strict'
import { connect, LIVE, offlineOnly, section, show, wire } from './_client.mts'

const { client, calls } = await connect(
  {
    'GET /me': { body: { id: '1' } },
    'GET /sale/products': { body: { products: [], filters: [] } },
    'POST /sale/product-offers': { status: 201, body: {} },
  },
  {
    // Allegro does not enforce a User-Agent (checked 2026-10-15) but an identifying one is good practice.
    userAgent: 'my-shop-sync/2.1 (+https://shop.example/contact)',
    defaultHeaders: { 'Accept-Language': 'pl-PL', 'X-Correlation-Id': 'nightly-sync' },
  },
)

section('defaults reach every call')
await client.get('/me')
show('on the wire', wire(calls.at(-1)!))
offlineOnly(() => {
  assert.equal(calls[0].headers.get('user-agent'), 'my-shop-sync/2.1 (+https://shop.example/contact)')
  assert.equal(calls[0].headers.get('accept'), 'application/vnd.allegro.public.v1+json')
})

section('per-request headers win, e.g. a beta media type or another language')
await client.get('/me', { headers: { Accept: 'application/vnd.allegro.beta.v1+json', 'Accept-Language': 'en-US' } })
show('on the wire', wire(calls.at(-1)!))
offlineOnly(() => assert.equal(calls.at(-1)!.headers.get('accept-language'), 'en-US'))

section('writes: json defaults Content-Type to the vendor type, strings are sent without one')
await client.post('/sale/product-offers', { json: { name: 'Mug' } })
show('json', wire(calls.at(-1)!).headers)
// A string body carries NO Content-Type unless you set one (Allegro answers 415 for text/plain and application/json).
await client.post('/sale/product-offers', { body: '{"name":"Mug"}' })
show('string body, content-type', calls.at(-1)!.headers.get('content-type') ?? '(none)')
await client.post('/sale/product-offers', {
  body: '{"name":"Mug"}',
  headers: { 'Content-Type': 'application/vnd.allegro.public.v1+json' },
})
show('string body with an explicit type', calls.at(-1)!.headers.get('content-type') ?? '(none)')

if (LIVE) {
  section('live: some endpoints need a header, and the 422 tells you which')
  const failure = await client
    .get('/sale/products', { qs: { phrase: 'laptop' }, headers: { 'Accept-Language': 'xx' } })
    .catch((e) => e)
  show('Allegro says', failure.errors?.[0]?.code ?? failure)
}
