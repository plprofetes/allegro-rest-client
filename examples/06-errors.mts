/**
 * Errors: what a failed call rejects with, in both modes.
 *
 *   node examples/06-errors.mts                         offline
 *   LIVE=1 node --env-file=.env examples/06-errors.mts  sandbox: a real 422 and its trace-id
 *
 * Default (`errorMode: 'plain'`, as in 1.x): a plain object, in one of these shapes
 *   { errors: [{ code, message, userMessage, details, path, metadata }] }   Allegro API error, unchanged
 *   { error, error_description }                                            OAuth errors and the library's own
 * Opt-in `errorMode: 'class'`: an `AllegroApiError` (a real Error with a stack) with the same fields plus
 * `status`, `headers`, `body` and `requestId` (Allegro's `trace-id`: quote it when contacting support).
 * Errors thrown by your own policy are never converted.
 */
import assert from 'node:assert/strict'
import {
  AllegroApiError,
  AllegroRestClient,
  isAllegroError,
  isTransportError,
  type AuthResponse,
} from 'allegro-rest-client'
import { connect, LIVE, offlineOnly, section, show } from './_client.mts'

// tokens for a client whose network we sabotage below
const tokens: AuthResponse = {
  access_token: 'a',
  refresh_token: 'r',
  token_type: 'bearer',
  expires_in: 43200,
  created_at: Math.floor(Date.now() / 1000),
  scope: '',
  jti: 'j',
}

const apiError = {
  errors: [
    {
      code: 'NotFoundException',
      message: 'Offer 42 not found',
      userMessage: 'Oferta nie istnieje',
      details: 'OfferNotFound',
      path: '/sale/offers/42',
      metadata: {},
    },
  ],
}
const routes = {
  'GET /sale/offers/42': { status: 404, body: apiError, headers: { 'trace-id': '4f1a9c0d22b7e801' } },
  'GET /sale/products': { status: 422, body: apiError, headers: { 'trace-id': '4f1a9c0d22b7e802' } },
}
const target = LIVE ? '/sale/products' : '/sale/offers/42' // live: no Accept-Language -> a real 422

section("plain mode: the rejection is Allegro's body")
const plain = await (await connect(routes)).client.get(target).catch((e) => e)
show('instanceof Error', plain instanceof Error)
show('isAllegroError', isAllegroError(plain))
show('code', plain.errors?.[0]?.code)
// HTTP details are attached but NOT enumerable, so JSON.stringify(err) and Object.keys(err) stay clean:
show('status / trace-id', [plain.status, plain.headers?.get('trace-id')])

section("class mode: errorMode: 'class'")
const { client } = await connect(routes, { errorMode: 'class' })
const err = await client.get(target).catch((e) => e)
assert.ok(err instanceof AllegroApiError)
show('instanceof Error', err instanceof Error)
show('message', err.message)
show('status', err.status)
show('requestId (trace-id)', err.requestId)
show('first error', err.errors?.[0]?.code)
offlineOnly(() => assert.equal(err.requestId, '4f1a9c0d22b7e801'))

section('transport failures (no response at all) are { error: "request_err" } / AllegroApiError too')
const unplugged = await AllegroRestClient(
  { app_name: 'demo', type: 'device', client_id: 'id', client_secret: 'secret' },
  {
    storage: { get: () => tokens, set: () => {} },
    fetch: async () => {
      throw new TypeError('fetch failed', {
        cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
      })
    },
  },
)
const down = await unplugged.get('/me').catch((e) => e)
show('isTransportError', isTransportError(down))
show('underlying code', down.error_description?.code)

section('what to do with them')
console.log(
  '   - status/code to branch on: err.errors?.[0].code, err.error ("invalid_grant", "request_err", "http_error", ...)',
)
console.log('   - the user-facing text is errors[0].userMessage (Allegro localises it by Accept-Language)')
console.log('   - retries are a policy decision, see 07-retries-and-policies.mts')
