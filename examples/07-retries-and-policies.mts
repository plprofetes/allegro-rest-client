/**
 * Policies: retries and custom handling of responses.
 *
 *   node examples/07-retries-and-policies.mts         offline only (a 429 cannot be provoked on purpose)
 *
 * After EVERY response (or network failure) a policy function decides: `return` the outcome, `retry` after a
 * delay, or `throw` an error of your choosing. The default policy never retries and produces the errors you saw
 * in 06-errors.mts. Policies compose through `next`, and can be set per client or per request.
 */
import assert from 'node:assert/strict'
import {
  defaultPolicy,
  retry429Policy,
  transientRetryPolicy,
  type PolicyContext,
  type PolicyDecision,
} from 'allegro-rest-client'
import { connect, section, show } from './_client.mts'

// 1. the presets. `sleep` is injectable, so this example does not actually wait.
section('retry429Policy: waits for Retry-After, then the call succeeds')
let attempts = 0
const waits: number[] = []
const throttled = await connect(
  {
    'GET /sale/categories': () =>
      ++attempts < 3
        ? {
            status: 429,
            body: { errors: [{ code: 'TooManyRequests', message: 'slow down' }] },
            headers: { 'retry-after': '2' },
          }
        : { body: { categories: [] } },
  },
  {
    policy: retry429Policy({ maxAttempts: 4, next: transientRetryPolicy() }), // 429 first, then 502/503/504 + network errors
    sleep: async (ms) => void waits.push(ms),
    hooks: { onRetry: (e) => console.log(`   retry #${e.attempt} of ${e.method} in ${e.delayMs} ms`) },
  },
)
await throttled.client.get('/sale/categories')
show('requests', attempts)
assert.deepEqual(waits, [2000, 2000])

section('transientRetryPolicy never retries POST (it might have been processed)')
let posts = 0
const flaky = await connect(
  {
    'POST /sale/offer-publication-commands/c1': () => (
      ++posts,
      { status: 503, body: 'down', headers: { 'content-type': 'text/plain' } }
    ),
  },
  { policy: transientRetryPolicy(), sleep: async () => {} },
)
const refused = await flaky.client
  .request('/sale/offer-publication-commands/c1', { method: 'POST', json: {} })
  .catch((e) => e)
show('posted once, error', [posts, refused.error])

// 2. your own policy: a function from context to decision
section('custom policy: treat 404 as data, and turn 401 into your own error')
class NotAuthorized extends Error {}
const mine = (ctx: PolicyContext): PolicyDecision => {
  // ctx.request: { method, url, kind: 'api' | 'token', idempotent, replayable, signal }
  // ctx.attempt (1-based), ctx.response / ctx.body / ctx.json, or ctx.error for transport failures
  if (ctx.request.kind === 'api' && ctx.response?.status === 404) return { action: 'return' } // caller gets the parsed body
  if (ctx.response?.status === 401) return { action: 'throw', error: new NotAuthorized('log in again') }
  return defaultPolicy(ctx) // everything else as usual
}
const custom = await connect(
  {
    'GET /sale/offers/gone': { status: 404, body: { errors: [{ code: 'NotFoundException' }] } },
    'GET /me': { status: 401, body: { error: 'invalid_token' } },
  },
  { policy: mine },
)
show('404 resolves to', await custom.client.get('/sale/offers/gone'))
const unauthorized = await custom.client.get('/me').catch((e) => e)
show('401 rejects with', unauthorized.constructor.name)
assert.ok(unauthorized instanceof NotAuthorized)

section('per request: { policy } overrides the client policy for one call')
const strict = await custom.client.get('/sale/offers/gone', { policy: defaultPolicy }).catch((e) => e)
show('same 404 with the default policy', strict.errors?.[0]?.code)
