import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AllegroApiError, AllegroRestClient, isAllegroError, type ClientOptions } from '../src'
import { config, json, memoryStorage, mockFetch, tokens } from './helpers'

// like a socket, a pending request keeps the event loop alive (AbortSignal.timeout timers are unref'd)
const hang = (req: { signal: AbortSignal | null | undefined }) =>
  new Promise<Response>((_, reject) => {
    const keepAlive = setTimeout(() => {}, 5000)
    req.signal?.addEventListener('abort', () => {
      clearTimeout(keepAlive)
      reject(req.signal!.reason)
    })
  })

async function setup(extra: ClientOptions = {}, responder: Parameters<typeof mockFetch>[0] = () => json({ ok: true })) {
  const m = mockFetch(responder)
  const client = await AllegroRestClient(config, { storage: memoryStorage(tokens()).storage, fetch: m.fetch, ...extra })
  return { client, ...m }
}

test('default headers; caller headers override case-insensitively', async () => {
  const { client, calls } = await setup()
  await client.get('/sale/categories')
  assert.equal(calls[0].url, 'https://api.allegro.pl/sale/categories')
  assert.equal(calls[0].headers.get('authorization'), `Bearer ${tokens().access_token}`)
  assert.equal(calls[0].headers.get('accept'), 'application/vnd.allegro.public.v1+json')

  await client.get('/x', { headers: { accept: 'application/vnd.allegro.beta.v1+json', 'User-Agent': 'my-app/1' } })
  assert.equal(calls[1].headers.get('accept'), 'application/vnd.allegro.beta.v1+json')
  assert.equal(calls[1].headers.get('user-agent'), 'my-app/1')
})

test('sandbox uses the sandbox API host', async () => {
  const { client, calls } = await setup({ sandbox: true })
  await client.get('/me')
  assert.equal(calls[0].url, 'https://api.allegro.pl.allegrosandbox.pl/me')
})

test('qs: arrays become repeated keys, existing query is extended, null/undefined are skipped', async () => {
  const { client, calls } = await setup()
  await client.get('/ads', { qs: { types: ['A', 'B'], limit: 10, skip: undefined, none: null } })
  assert.equal(calls[0].url, 'https://api.allegro.pl/ads?types=A&types=B&limit=10')
  await client.get('/ads?x=1', { qs: { y: 2 } })
  assert.equal(calls[1].url, 'https://api.allegro.pl/ads?x=1&y=2')
})

test('qs: nested objects are rejected', async () => {
  const { client } = await setup()
  await assert.rejects(client.get('/x', { qs: { a: { b: 1 } } }), { error: 'invalid_option' })
})

test('string bodies are sent without an implicit content type (as in 1.x)', async () => {
  const { client, calls } = await setup()
  await client.post('/sale/offers', { body: JSON.stringify({ name: 'Test' }) })
  assert.equal(calls[0].method, 'POST')
  assert.equal(calls[0].body, '{"name":"Test"}')
  assert.equal(calls[0].headers.has('content-type'), false)
  assert.ok(calls[0].rawBody instanceof Uint8Array)
})

test('json option serializes the body; content type defaults to the Accept media type', async () => {
  const { client, calls } = await setup()
  await client.post('/sale/offers', { json: { name: 'Test' } })
  assert.equal(calls[0].body, '{"name":"Test"}')
  assert.equal(calls[0].headers.get('content-type'), 'application/vnd.allegro.public.v1+json')
  await client.post('/x', { json: [1, 2], headers: { 'content-type': 'application/json' } })
  assert.equal(calls[1].headers.get('content-type'), 'application/json')
})

test('form option sends urlencoded', async () => {
  const { client, calls } = await setup()
  await client.post('/x', { form: { a: 1, b: 'two' } })
  assert.equal(calls[0].body, 'a=1&b=two')
  assert.equal(calls[0].headers.get('content-type'), 'application/x-www-form-urlencoded')
})

test('body, form and json are mutually exclusive', async () => {
  const { client } = await setup()
  await assert.rejects(client.post('/x', { body: 'a', json: {} }), { error: 'invalid_option' })
})

test('request options without an equivalent are refused loudly', async () => {
  const { client } = await setup()
  await assert.rejects(client.get('/x', { proxy: 'http://p' } as any), { error: 'unsupported_option' })
  await assert.rejects(client.get('/x', { uri: 'https://elsewhere' } as any), { error: 'unsupported_option' })
})

test('patch, put and delete use their verbs; request defaults to GET', async () => {
  const { client, calls } = await setup()
  await client.patch('/a')
  await client.put('/b')
  await client.delete('/c')
  await client.request('/d')
  assert.deepEqual(
    calls.map((c) => c.method),
    ['PATCH', 'PUT', 'DELETE', 'GET'],
  )
})

test('typed responses via generics', async () => {
  const { client } = await setup({}, () => json({ id: '7' }))
  const me = await client.get<{ id: string }>('/me')
  assert.equal(me.id, '7')
})

test('timeout aborts a hanging request as request_err', async () => {
  const { client } = await setup({}, hang as any)
  await assert.rejects(client.get('/slow', { timeout: 30 }), (err: any) => {
    assert.equal(err.error, 'request_err')
    assert.equal(err.error_description.name, 'TimeoutError')
    return true
  })
})

test('a caller AbortSignal cancels the request', async () => {
  const { client } = await setup({}, hang as any)
  const ctrl = new AbortController()
  const pending = client.get('/slow', { signal: ctrl.signal })
  ctrl.abort()
  await assert.rejects(pending, { error: 'request_err' })
})

test('upload host: per-request selection, sandbox aware, binary bodies pass through', async () => {
  const { client, calls } = await setup()
  const image = new Uint8Array([1, 2, 3])
  await client.post('/sale/images', { host: 'upload', body: image, headers: { 'Content-Type': 'image/png' } })
  assert.equal(calls[0].url, 'https://upload.allegro.pl/sale/images')
  assert.equal(calls[0].rawBody, image)
  assert.equal(calls[0].headers.get('content-type'), 'image/png')

  const sandbox = await setup({ sandbox: true })
  await sandbox.client.put('/sale/offer-attachments/1', { host: 'upload', body: new Blob(['x']) })
  assert.equal(sandbox.calls[0].url, 'https://upload.allegro.pl.allegrosandbox.pl/sale/offer-attachments/1')
})

test('absolute URLs are accepted only for the active environment', async () => {
  const { client, calls } = await setup()
  await client.get('https://upload.allegro.pl/sale/images/1')
  assert.equal(calls[0].url, 'https://upload.allegro.pl/sale/images/1')
  await assert.rejects(client.get('https://evil.example/steal'), { error: 'invalid_endpoint' })
  await assert.rejects(client.get('https://api.allegro.pl.evil.example/x'), { error: 'invalid_endpoint' })
  await assert.rejects(client.get('https://api.allegro.pl.allegrosandbox.pl/me'), { error: 'invalid_endpoint' })
  assert.equal(calls.length, 1)
})

test('raw returns the native Response for binary downloads', async () => {
  const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46])
  const { client } = await setup(
    {},
    () => new Response(bytes, { status: 200, headers: { 'content-type': 'application/pdf' } }),
  )
  const res = await client.get<Response>('/shipment-management/label', { raw: true })
  assert.ok(res instanceof Response)
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), bytes)
})

test('raw still rejects non-2xx responses through the policy', async () => {
  const { client } = await setup({}, () => new Response('nope', { status: 404 }))
  await assert.rejects(client.get('/x', { raw: true }), (err: any) => err.error === 'http_error' && err.status === 404)
})

test('hooks report request, response (with duration and request id), error; hook exceptions are ignored', async () => {
  const events: any[] = []
  let t = 1000
  const { client } = await setup(
    {
      now: () => (t += 25),
      hooks: {
        onRequest: (e) => {
          events.push(['request', e])
          throw new Error('hook bug')
        },
        onResponse: (e) => events.push(['response', e]),
        onError: (e) => events.push(['error', e]),
      },
    },
    (_req, n) =>
      n === 1 ? json({ ok: 1 }, 200, { 'trace-id': 'abc' }) : Promise.reject(new TypeError('fetch failed')),
  )
  await client.get('/a')
  await assert.rejects(client.get('/b'), { error: 'request_err' })
  const [req, res, , err] = events
  assert.equal(req[1].url, 'https://api.allegro.pl/a')
  assert.equal(req[1].kind, 'api')
  assert.equal(res[1].status, 200)
  assert.equal(res[1].requestId, 'abc')
  assert.equal(res[1].durationMs, 25)
  assert.equal(err[0], 'error')
  assert.ok(!JSON.stringify(events).includes(tokens().access_token))
})

test('a single options object does not leak between clients (default storage is per client)', async () => {
  const a = await AllegroRestClient(config)
  const b = await AllegroRestClient(config)
  assert.equal(a.getExpiresInHours(), b.getExpiresInHours())
})

test('defaultHeaders and userAgent reach API calls; per-request headers win', async () => {
  const stored = tokens()
  const { fetch, calls } = mockFetch(() => json({}))
  const client = await AllegroRestClient(config, {
    fetch,
    storage: memoryStorage(stored).storage,
    userAgent: 'my-app/1',
    defaultHeaders: { 'X-Team': 'a', Accept: 'application/vnd.allegro.beta.v1+json' },
  })
  await client.get('/x')
  await client.get('/x', { headers: { 'x-team': 'b' } })
  assert.equal(calls[0].headers.get('user-agent'), 'my-app/1')
  assert.equal(calls[0].headers.get('x-team'), 'a')
  assert.equal(calls[0].headers.get('accept'), 'application/vnd.allegro.beta.v1+json')
  assert.equal(calls[0].headers.get('authorization'), `Bearer ${stored.access_token}`)
  assert.equal(calls[1].headers.get('x-team'), 'b')
})

test('a pino-style logger receives structured records (no credentials)', async () => {
  const records: unknown[][] = []
  const rec = (level: string) => (fields: object, message: string) => records.push([level, fields, message])
  const logger = { debug: rec('debug'), info: rec('info'), warn: rec('warn') }
  const { fetch } = mockFetch(() => json({}))
  const stored = tokens()
  const client = await AllegroRestClient(config, { fetch, logger, storage: memoryStorage(stored).storage })
  await client.get('/x')
  const request = records.find((r) => (r[2] as string).startsWith('request:'))!
  assert.equal(request[0], 'debug')
  assert.deepEqual(request[1], {
    app_name: 'test-app',
    account: 'default',
    method: 'GET',
    url: 'https://api.allegro.pl/x',
    kind: 'api',
    attempt: 1,
  })
  assert.ok(!JSON.stringify(records).includes(stored.access_token))
})

test('paginate walks offset/limit pages until a short page', async () => {
  const all = Array.from({ length: 5 }, (_, i) => ({ id: i }))
  const { fetch, calls } = mockFetch((req) => {
    const q = new URL(req.url).searchParams
    const offset = Number(q.get('offset'))
    const items = all.slice(offset, offset + Number(q.get('limit')))
    return json({ offers: items, count: items.length, totalCount: 5 })
  })
  const client = await AllegroRestClient(config, { fetch, storage: memoryStorage(tokens()).storage })
  const seen: unknown[] = []
  for await (const offer of client.paginate('/sale/offers', { qs: { limit: 2, 'publication.status': 'ACTIVE' } })) {
    seen.push(offer)
  }
  assert.deepEqual(seen, all)
  assert.deepEqual(
    calls.map((c) => new URL(c.url).searchParams.get('offset')),
    ['0', '2', '4'],
  )
  assert.equal(new URL(calls[0].url).searchParams.get('publication.status'), 'ACTIVE')
})

test('paginate honours maxItems, itemsKey and refuses to guess among several arrays', async () => {
  const { fetch, calls } = mockFetch(() => json({ a: [1, 2, 3], b: [4] }))
  const client = await AllegroRestClient(config, { fetch, storage: memoryStorage(tokens()).storage })
  const drain = async (gen: AsyncIterable<unknown>) => {
    const out: unknown[] = []
    for await (const x of gen) out.push(x)
    return out
  }
  await assert.rejects(drain(client.paginate('/x')), { error: 'invalid_response' })
  assert.deepEqual(await drain(client.paginate('/x', { itemsKey: 'a', maxItems: 2, qs: { limit: 3 } })), [1, 2])
  assert.equal(calls.length, 2)
})

test("errorMode 'class' rejects with AllegroApiError carrying the same fields plus HTTP details", async () => {
  const { fetch } = mockFetch((req) =>
    req.url.includes('/token')
      ? json({ error: 'invalid_grant', error_description: 'bad refresh' }, 400)
      : json({ errors: [{ code: 'ERROR', message: 'm', userMessage: 'Not found', details: 'X' }] }, 404, {
          'trace-id': 'abc123',
        }),
  )
  const client = await AllegroRestClient(config, {
    fetch,
    errorMode: 'class',
    storage: memoryStorage(tokens()).storage,
  })
  const api = await client.get('/sale/offers/1').catch((e) => e)
  assert.ok(api instanceof AllegroApiError && api instanceof Error)
  assert.equal(api.status, 404)
  assert.equal(api.requestId, 'abc123')
  assert.equal(api.errors?.[0].details, 'X')
  assert.equal(api.message, 'ERROR: Not found')
  assert.ok(isAllegroError(api))
  assert.ok(api.stack)

  const oauth = await client.authorize('dc').catch((e) => e)
  assert.ok(oauth instanceof AllegroApiError)
  assert.equal(oauth.error, 'invalid_grant')
  assert.equal(oauth.message, 'invalid_grant: bad refresh')

  const missing = await (await AllegroRestClient(config, { fetch, errorMode: 'class' })).get('/x').catch((e) => e)
  assert.equal(missing.error, 'missing_access_token')
  assert.ok(missing instanceof AllegroApiError)
})

test("errorMode 'class' leaves your own policy errors alone and defaults stay plain", async () => {
  class Mine extends Error {}
  const { fetch } = mockFetch(() => json({}, 500))
  const storage = memoryStorage(tokens()).storage
  const custom = await AllegroRestClient(config, {
    fetch,
    storage,
    errorMode: 'class',
    policy: () => ({ action: 'throw', error: new Mine() }),
  })
  assert.ok((await custom.get('/x').catch((e) => e)) instanceof Mine)
  const plain = await AllegroRestClient(config, { fetch, storage })
  const err = await plain.get('/x').catch((e) => e)
  assert.ok(!(err instanceof Error))
})
