import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AllegroRestClient, isAllegroError, isTransportError, type ClientConfig } from '../src'
import { config, json, jwt, memoryStorage, mockFetch, tokens, webConfig, within } from './helpers'

test('works with options omitted and exposes the documented surface', async () => {
  const client = await AllegroRestClient(config)
  assert.equal(client.getAccount(), 'default')
  for (const name of ['request', 'get', 'post', 'put', 'patch', 'delete', 'authorize', 'getSellerId'] as const) {
    assert.equal(typeof client[name], 'function', name)
  }
  assert.equal(client.getSellerId(), null)
})

test('bindApp exists for device apps only', async () => {
  assert.equal(typeof (await AllegroRestClient(config)).bindApp, 'function')
  assert.equal((await AllegroRestClient(webConfig)).bindApp, undefined)
})

test('config.type accepts a plain string', async () => {
  const type: string = 'device'
  const cfg: ClientConfig = { ...config, type }
  assert.equal(typeof (await AllegroRestClient(cfg)).bindApp, 'function')
})

test('without tokens, requests reject with missing_access_token and exactly two keys', async () => {
  const client = await AllegroRestClient(config, { account: 'nobody' })
  await assert.rejects(client.get('/sale/offers/123'), (err: any) => {
    assert.deepEqual(Object.keys(err).sort(), ['error', 'error_description'])
    assert.equal(err.error, 'missing_access_token')
    assert.equal(err.error_description, 'Access token is missing or not stored in the app.')
    return true
  })
})

test('storage.get is called once, at construction', async () => {
  const { storage, calls } = memoryStorage(tokens())
  const { fetch } = mockFetch(() => json({ ok: true }))
  const client = await AllegroRestClient(config, { storage, fetch })
  await client.get('/me')
  await client.get('/me')
  await client.post('/x')
  assert.equal(calls.get, 1)
})

test('storage may be async and loosely typed', async () => {
  const stored = tokens()
  const storage = {
    async set(_account: string, _tokens: any) {},
    async get(_account: string): Promise<any> {
      return stored
    },
  }
  const { fetch } = mockFetch(() => json({ id: 'u1' }))
  const client = await AllegroRestClient(config, { storage, fetch })
  assert.deepEqual(await client.get('/me'), { id: 'u1' })
})

test('Allegro API errors reject with the response body; HTTP details are not enumerable', async () => {
  const body = { errors: [{ code: 'NotFoundException', message: 'nope', path: '/x', details: null, userMessage: 'x' }] }
  const { fetch } = mockFetch(() => json(body, 404, { 'x-extra': '1' }))
  const client = await AllegroRestClient(config, { storage: memoryStorage(tokens()).storage, fetch })
  await assert.rejects(client.get('/sale/offers/1'), (err: any) => {
    assert.deepEqual(Object.keys(err), ['errors'])
    assert.equal(JSON.stringify(err), JSON.stringify(body))
    assert.equal(err.status, 404)
    assert.equal(err.headers.get('x-extra'), '1')
    assert.ok(isAllegroError(err))
    return true
  })
})

test('a 200 response with a top-level errors field is still rejected', async () => {
  const { fetch } = mockFetch(() => json({ errors: [{ code: 'X', message: 'failed' }] }, 200))
  const client = await AllegroRestClient(config, { storage: memoryStorage(tokens()).storage, fetch })
  await assert.rejects(client.get('/shipment-management/shipments/create-commands/1'), (err: any) => {
    assert.equal(err.errors[0].code, 'X')
    return true
  })
})

test('OAuth-style errors reject with {error, error_description}', async () => {
  const { fetch } = mockFetch(() => json({ error: 'invalid_token', error_description: 'expired' }, 401))
  const client = await AllegroRestClient(config, { storage: memoryStorage(tokens()).storage, fetch })
  await assert.rejects(client.get('/me'), { error: 'invalid_token', error_description: 'expired' })
})

test('network failures reject as request_err carrying the underlying error code', async () => {
  const { fetch } = mockFetch(() => {
    throw new TypeError('fetch failed', { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) })
  })
  const client = await AllegroRestClient(config, { storage: memoryStorage(tokens()).storage, fetch })
  await assert.rejects(client.get('/me'), (err: any) => {
    assert.deepEqual(Object.keys(err).sort(), ['error', 'error_description'])
    assert.equal(err.error, 'request_err')
    assert.equal(err.error_description.code, 'ECONNRESET')
    assert.ok(isTransportError(err))
    return true
  })
})

test('non-JSON error pages reject cleanly instead of crashing the process', async () => {
  const { fetch } = mockFetch(() => new Response('<html>Bad Gateway</html>', { status: 502 }))
  const client = await AllegroRestClient(config, { storage: memoryStorage(tokens()).storage, fetch })
  await within(
    assert.rejects(client.get('/me'), (err: any) => {
      assert.equal(err.error, 'http_error')
      assert.match(err.error_description, /HTTP 502/)
      assert.equal(err.status, 502)
      return true
    }),
  )
})

test('a 2xx response that is not JSON rejects as invalid_response', async () => {
  const { fetch } = mockFetch(() => new Response('plain text', { status: 200 }))
  const client = await AllegroRestClient(config, { storage: memoryStorage(tokens()).storage, fetch })
  await assert.rejects(client.get('/me'), { error: 'invalid_response' })
})

test('an empty body resolves to an empty string (204)', async () => {
  const { fetch } = mockFetch(() => new Response(null, { status: 204 }))
  const client = await AllegroRestClient(config, { storage: memoryStorage(tokens()).storage, fetch })
  assert.equal(await client.delete('/sale/offers/1'), '')
})

test('getSellerId reads user_name from the access token', async () => {
  const client = await AllegroRestClient(config, { storage: memoryStorage(tokens()).storage })
  assert.equal(client.getSellerId(), 'seller-1')
})

test('getExpiresInHours returns a string with two decimals', async () => {
  const client = await AllegroRestClient(config, { storage: memoryStorage(tokens(5)).storage })
  assert.match(client.getExpiresInHours(), /^\d+\.\d{2}$/)
  assert.ok(Math.abs(Number(client.getExpiresInHours()) - 5) < 0.01)
})

test('tokens without created_at: expiry comes from the JWT exp claim', async () => {
  const exp = Math.floor(Date.now() / 1000) + 3 * 3600
  const t = tokens(12, { access_token: jwt({ exp }), created_at: undefined })
  const client = await AllegroRestClient(config, { storage: memoryStorage(t).storage })
  assert.ok(Math.abs(Number(client.getExpiresInHours()) - 3) < 0.01)
})

test('tokens with unknown expiry do not trigger a refresh on every request', async () => {
  const t = tokens(12, { access_token: 'opaque-token', created_at: undefined })
  const { fetch, calls } = mockFetch(() => json({ ok: true }))
  const client = await AllegroRestClient(config, { storage: memoryStorage(t).storage, fetch })
  await client.get('/me')
  await client.get('/me')
  assert.equal(calls.length, 2)
  assert.ok(calls.every((c) => c.url.startsWith('https://api.')))
})
