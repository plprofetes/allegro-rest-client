import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  AllegroRestClient,
  defaultPolicy,
  parseRetryAfter,
  retry429Policy,
  transientRetryPolicy,
  type ClientOptions,
  type ResponsePolicy,
} from '../src'
import { config, json, memoryStorage, mockFetch, tokens } from './helpers'

async function setup(responder: Parameters<typeof mockFetch>[0], extra: ClientOptions = {}) {
  const sleeps: number[] = []
  const m = mockFetch(responder)
  const client = await AllegroRestClient(config, {
    storage: memoryStorage(tokens()).storage,
    fetch: m.fetch,
    sleep: async (ms) => {
      sleeps.push(ms)
    },
    ...extra,
  })
  return { client, sleeps, ...m }
}

const tooMany = (retryAfter?: string) =>
  json(
    { errors: [{ code: 'TooManyRequests', message: 'slow down' }] },
    429,
    retryAfter ? { 'retry-after': retryAfter } : {},
  )

test('default policy never retries', async () => {
  const { client, calls, sleeps } = await setup(() => tooMany('1'))
  await assert.rejects(client.get('/x'), (err: any) => err.errors && err.status === 429)
  assert.equal(calls.length, 1)
  assert.equal(sleeps.length, 0)
})

test('retry429Policy waits for Retry-After seconds, then succeeds', async () => {
  const { client, calls, sleeps } = await setup((_r, n) => (n < 3 ? tooMany('2') : json({ ok: 1 })), {
    policy: retry429Policy(),
  })
  assert.deepEqual(await client.get('/x'), { ok: 1 })
  assert.equal(calls.length, 3)
  assert.deepEqual(sleeps, [2000, 2000])
})

test('retry429Policy: HTTP-date Retry-After, cap, and exhausted attempts surface the final error', async () => {
  const now = Date.parse('2026-01-01T00:00:00Z')
  const date = new Date(now + 5000).toUTCString()
  assert.equal(parseRetryAfter(date, now), 5000)
  assert.equal(parseRetryAfter('7'), 7000)
  assert.equal(parseRetryAfter('garbage'), undefined)
  assert.equal(parseRetryAfter(null), undefined)

  const { client, calls, sleeps } = await setup(() => tooMany('600'), {
    policy: retry429Policy({ maxAttempts: 2, maxDelayMs: 10_000 }),
  })
  await assert.rejects(client.get('/x'), (err: any) => err.status === 429)
  assert.equal(calls.length, 2)
  assert.deepEqual(sleeps, [10_000])
})

test('retry429Policy without Retry-After backs off exponentially with jitter', async () => {
  const { client, sleeps } = await setup((_r, n) => (n < 3 ? tooMany() : json({})), {
    policy: retry429Policy({ baseDelayMs: 1000, random: () => 1 }),
  })
  await client.get('/x')
  assert.deepEqual(sleeps, [1000, 2000])
})

test('retry429Policy retries POST too (a 429 request was not processed) but not token calls', async () => {
  const { client, calls } = await setup((_r, n) => (n === 1 ? tooMany('0') : json({ id: 1 })), {
    policy: retry429Policy(),
  })
  assert.deepEqual(await client.post('/sale/offers', { body: '{}' }), { id: 1 })
  assert.equal(calls.length, 2)

  const tokenCalls = mockFetch(() => tooMany('0'))
  const c = await AllegroRestClient({ ...config, type: 'web' }, { fetch: tokenCalls.fetch, policy: retry429Policy() })
  await assert.rejects(c.authorize('code'))
  assert.equal(tokenCalls.calls.length, 1)
})

test('transientRetryPolicy retries idempotent requests on transport errors and 503, never POST', async () => {
  const flaky = (_r: unknown, n: number) =>
    n < 3 ? Promise.reject(new TypeError('fetch failed')) : Promise.resolve(json({ ok: 1 }))
  const get = await setup(flaky, { policy: transientRetryPolicy({ random: () => 0 }) })
  assert.deepEqual(await get.client.get('/x'), { ok: 1 })
  assert.equal(get.calls.length, 3)

  const post = await setup(flaky, { policy: transientRetryPolicy() })
  await assert.rejects(post.client.post('/x', { body: '{}' }), { error: 'request_err' })
  assert.equal(post.calls.length, 1)

  const unavailable = await setup((_r, n) => (n === 1 ? new Response('x', { status: 503 }) : json({ ok: 1 })), {
    policy: transientRetryPolicy(),
  })
  assert.deepEqual(await unavailable.client.get('/x'), { ok: 1 })
})

test('presets compose through `next`', async () => {
  const policy = retry429Policy({ next: transientRetryPolicy() })
  const { client, calls } = await setup(
    (_r, n) => (n === 1 ? tooMany('0') : n === 2 ? new Response('x', { status: 502 }) : json({ ok: 1 })),
    { policy },
  )
  assert.deepEqual(await client.get('/x'), { ok: 1 })
  assert.equal(calls.length, 3)
})

test('caller aborts are not retried', async () => {
  const ctrl = new AbortController()
  const { client, calls } = await setup(
    () => {
      ctrl.abort()
      return Promise.reject(new DOMException('aborted', 'AbortError'))
    },
    { policy: transientRetryPolicy() },
  )
  await assert.rejects(client.get('/x', { signal: ctrl.signal }), { error: 'request_err' })
  assert.equal(calls.length, 1)
})

test('stream bodies are never retried (they cannot be re-sent)', async () => {
  const { client, calls } = await setup(() => tooMany('0'), { policy: retry429Policy() })
  const body = new ReadableStream({
    start(c) {
      c.enqueue(new Uint8Array([1]))
      c.close()
    },
  })
  await assert.rejects(
    client.put('/sale/offer-attachments/1', { host: 'upload', body }),
    (err: any) => err.status === 429,
  )
  assert.equal(calls.length, 1)
})

test('a per-request policy overrides the client policy', async () => {
  const { client, calls } = await setup((_r, n) => (n === 1 ? tooMany('0') : json({ ok: 1 })))
  await assert.rejects(client.get('/a'))
  assert.deepEqual(await client.get('/b', { policy: retry429Policy() }), { ok: 1 })
  assert.equal(calls.length, 2)
})

test('a custom policy decides everything: map statuses to your own errors', async () => {
  class QuotaError extends Error {}
  const policy: ResponsePolicy = (ctx) =>
    ctx.response?.status === 429 ? { action: 'throw', error: new QuotaError('quota') } : defaultPolicy(ctx)
  const { client } = await setup(() => tooMany(), { policy })
  await assert.rejects(client.get('/x'), QuotaError)
})

test('a custom policy may accept non-JSON responses', async () => {
  const policy: ResponsePolicy = () => ({ action: 'return' })
  const { client } = await setup(() => new Response('a,b\n1,2', { status: 200 }), { policy })
  assert.equal(await client.get('/report.csv'), 'a,b\n1,2')
})

test('retry hook reports the delay', async () => {
  const delays: number[] = []
  const { client } = await setup((_r, n) => (n === 1 ? tooMany('3') : json({})), {
    policy: retry429Policy(),
    hooks: { onRetry: (e) => delays.push(e.delayMs) },
  })
  await client.get('/x')
  assert.deepEqual(delays, [3000])
})
