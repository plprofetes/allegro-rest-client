import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AllegroRestClient, type DeviceResponse } from '../src'
import { config, json, memoryStorage, mockFetch, tokens, webConfig, within } from './helpers'

const newTokens = {
  access_token: 'new-access',
  refresh_token: 'new-refresh',
  token_type: 'bearer',
  expires_in: 43199,
  scope: 'x',
  jti: 'j',
}
const basic = `Basic ${Buffer.from('client-id:client-secret').toString('base64')}`

test('bindApp posts client_id as a form to the device endpoint (sandbox host)', async () => {
  const device = {
    device_code: 'dc',
    user_code: 'uc',
    expires_in: 3600,
    interval: 5,
    verification_uri: 'u',
    verification_uri_complete: 'uc-complete',
  }
  const { fetch, calls } = mockFetch(() => json(device))
  const client = await AllegroRestClient(config, { sandbox: true, fetch })
  assert.deepEqual(await client.bindApp!(), device)
  assert.equal(calls[0].url, 'https://allegro.pl.allegrosandbox.pl/auth/oauth/device')
  assert.equal(calls[0].method, 'POST')
  assert.equal(calls[0].headers.get('authorization'), basic)
  assert.equal(calls[0].body, 'client_id=client-id')
})

test('device authorize sends the grant in a form body (nothing secret in the URL), stores and uses the tokens', async () => {
  const { fetch, calls } = mockFetch((req) =>
    req.url.includes('/auth/oauth/token') ? json(newTokens) : json({ id: 'me' }),
  )
  const { storage, calls: sc, current } = memoryStorage()
  const client = await AllegroRestClient(config, { storage, fetch, account: 'acc', now: () => 1_700_000_000_000 })
  const result = await client.authorize('device-123')

  assert.equal(calls[0].url, 'https://allegro.pl/auth/oauth/token')
  assert.equal(calls[0].headers.get('authorization'), basic)
  assert.equal(calls[0].headers.get('content-type'), 'application/x-www-form-urlencoded')
  const form = new URLSearchParams(calls[0].body)
  assert.equal(form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:device_code')
  assert.equal(form.get('device_code'), 'device-123')
  assert.equal(result.created_at, 1_700_000_000)
  assert.equal(sc.set, 1)
  assert.equal(current()?.access_token, 'new-access')

  await client.get('/me')
  assert.equal(calls[1].headers.get('authorization'), 'Bearer new-access')
})

test('pending device authorization rejects with the server body', async () => {
  const body = { error: 'authorization_pending', error_description: 'Authorization pending: dc' }
  const { fetch } = mockFetch(() => json(body, 400))
  const client = await AllegroRestClient(config, { fetch })
  await assert.rejects(client.authorize('dc'), (err: any) => {
    assert.deepEqual({ ...err }, body)
    return true
  })
})

test('web authorize sends the code and redirect_uri; redirect_uri is omitted when not configured', async () => {
  const { fetch, calls } = mockFetch(() => json(newTokens))
  await (await AllegroRestClient(webConfig, { fetch })).authorize('the-code')
  const form = new URLSearchParams(calls[0].body)
  assert.equal(form.get('grant_type'), 'authorization_code')
  assert.equal(form.get('code'), 'the-code')
  assert.equal(form.get('redirect_uri'), 'https://example.test/cb')

  const { fetch: f2, calls: c2 } = mockFetch(() => json(newTokens))
  await (await AllegroRestClient({ ...webConfig, url_redirect: undefined }, { fetch: f2 })).authorize('c')
  assert.equal(new URLSearchParams(c2[0].body).has('redirect_uri'), false)
  assert.ok(!c2[0].body!.includes('undefined'))
})

test('tokenParams: query puts encoded parameters in the URL like 1.x', async () => {
  const { fetch, calls } = mockFetch(() => json(newTokens))
  const client = await AllegroRestClient(webConfig, { fetch, tokenParams: 'query' })
  await client.authorize('a b&c')
  const url = new URL(calls[0].url)
  assert.equal(url.pathname, '/auth/oauth/token')
  assert.equal(url.searchParams.get('code'), 'a b&c')
  assert.equal(url.searchParams.get('redirect_uri'), 'https://example.test/cb')
  assert.equal(calls[0].body, undefined)
})

test('tokens close to expiry are refreshed before the request, and the new token is used', async () => {
  const { fetch, calls } = mockFetch((req) =>
    req.url.includes('/auth/oauth/token') ? json(newTokens) : json({ ok: 1 }),
  )
  const { storage, calls: sc } = memoryStorage(tokens(0.5))
  const client = await AllegroRestClient(config, { storage, fetch })
  await client.get('/me')
  assert.equal(calls.length, 2)
  const form = new URLSearchParams(calls[0].body)
  assert.equal(form.get('grant_type'), 'refresh_token')
  assert.equal(form.get('refresh_token'), 'refresh-1')
  assert.equal(calls[1].headers.get('authorization'), 'Bearer new-access')
  assert.equal(sc.set, 1)
})

test('tokens with plenty of life are not refreshed; threshold is configurable; 0 disables refresh', async () => {
  const run = async (hoursLeft: number, refreshThresholdHours?: number) => {
    const { fetch, calls } = mockFetch((req) => (req.url.includes('/auth/oauth/token') ? json(newTokens) : json({})))
    const client = await AllegroRestClient(config, {
      storage: memoryStorage(tokens(hoursLeft)).storage,
      fetch,
      refreshThresholdHours,
    })
    await client.get('/me')
    return calls.filter((c) => c.url.includes('/auth/oauth/token')).length
  }
  assert.equal(await run(5), 0)
  assert.equal(await run(5, 6), 1)
  assert.equal(await run(0.1, 0), 0)
})

test('a failed refresh rejects the request with the server error', async () => {
  const { fetch } = mockFetch(() => json({ error: 'invalid_grant', error_description: 'Invalid refresh token' }, 400))
  const client = await AllegroRestClient(config, { storage: memoryStorage(tokens(0.2)).storage, fetch })
  await assert.rejects(client.get('/me'), { error: 'invalid_grant' })
})

test('refresh without a stored refresh token is reported when only an access token is near expiry', async () => {
  const { fetch, calls } = mockFetch(() => json({}))
  const client = await AllegroRestClient(config, {
    storage: memoryStorage(tokens(0.2, { refresh_token: '' })).storage,
    fetch,
  })
  await client.get('/me')
  assert.equal(calls.length, 1)
})

test('a non-JSON token response rejects instead of hanging', async () => {
  const { fetch } = mockFetch(() => new Response('<html>oops</html>', { status: 503 }))
  const client = await AllegroRestClient(webConfig, { fetch })
  await within(assert.rejects(client.authorize('c'), { error: 'http_error' }))
})

test('a failing storage.set rejects authorize instead of hanging', async () => {
  const { fetch } = mockFetch(() => json(newTokens))
  const storage = {
    get: () => undefined,
    set: () => {
      throw new Error('db down')
    },
  }
  const client = await AllegroRestClient(webConfig, { fetch, storage })
  await within(assert.rejects(client.authorize('c'), /db down/))
})

test('token and policy requests flow through hooks without credentials', async () => {
  const events: any[] = []
  const { fetch } = mockFetch(() => json(newTokens))
  const client = await AllegroRestClient(webConfig, {
    fetch,
    hooks: { onRequest: (e) => events.push(e), onResponse: (e) => events.push(e) },
  })
  await client.authorize('secret-code')
  assert.equal(events.length, 2)
  assert.equal(events[0].kind, 'token')
  assert.ok(!JSON.stringify(events).includes('secret-code'))
  assert.ok(!JSON.stringify(events).includes('client-secret'))
})

test('token calls carry defaultHeaders but cannot lose Authorization to them', async () => {
  const { fetch, calls } = mockFetch(() => json(newTokens))
  const client = await AllegroRestClient(config, {
    fetch,
    userAgent: 'my-app/1',
    defaultHeaders: { authorization: 'Bearer nope', 'content-type': 'text/plain', 'x-team': 'a' },
  })
  await client.authorize('dc')
  assert.equal(calls[0].headers.get('user-agent'), 'my-app/1')
  assert.equal(calls[0].headers.get('x-team'), 'a')
  assert.equal(calls[0].headers.get('authorization'), basic)
  assert.equal(calls[0].headers.get('content-type'), 'application/x-www-form-urlencoded')
})

test('authorizeApp uses client_credentials, stores the token, and re-requests it instead of refreshing', async () => {
  let t = 1_700_000_000_000
  const appToken = { ...newTokens, refresh_token: undefined, expires_in: 43198 }
  const { fetch, calls } = mockFetch((req) => (req.url.includes('/auth/oauth/token') ? json(appToken) : json({})))
  const { storage, current } = memoryStorage()
  const client = await AllegroRestClient(config, { storage, fetch, now: () => t })
  await client.authorizeApp()
  assert.equal(calls[0].body, 'grant_type=client_credentials')
  assert.equal(calls[0].headers.get('authorization'), basic)
  assert.equal(current()?.grant, 'client_credentials')
  await client.get('/sale/categories')
  assert.equal(calls.length, 2)
  t += 12 * 3600 * 1000
  await client.get('/sale/categories')
  assert.deepEqual(
    calls.map((c) => c.url.includes('/token')),
    [true, false, true, false],
  )
})

test('getAuthorizationUrl builds the web consent URL (sandbox host) and needs url_redirect', async () => {
  const client = await AllegroRestClient(webConfig, { sandbox: true })
  const url = new URL(client.getAuthorizationUrl({ state: 's 1', scope: ['a:b', 'c:d'] }))
  assert.equal(url.origin + url.pathname, 'https://allegro.pl.allegrosandbox.pl/auth/oauth/authorize')
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    response_type: 'code',
    client_id: 'client-id',
    redirect_uri: 'https://example.test/cb',
    state: 's 1',
    scope: 'a:b c:d',
  })
  const device = await AllegroRestClient(config)
  assert.throws(() => device.getAuthorizationUrl(), { error: 'invalid_option' })
})

test('pollDevice waits through authorization_pending and slow_down, then stores the tokens', async () => {
  const answers = [
    json({ error: 'authorization_pending' }, 400),
    json({ error: 'slow_down' }, 400),
    json({ error: 'authorization_pending' }, 400),
    json(newTokens),
  ]
  const { fetch, calls } = mockFetch((_req, n) => answers[n - 1])
  const sleeps: number[] = []
  const { storage, current } = memoryStorage()
  const client = await AllegroRestClient(config, { fetch, storage, sleep: async (ms) => void sleeps.push(ms) })
  const device = { device_code: 'dc', expires_in: 3600, interval: 5 } as DeviceResponse
  const result = await client.pollDevice(device)
  assert.equal(result.access_token, 'new-access')
  assert.equal(current()?.access_token, 'new-access')
  assert.deepEqual(sleeps, [5000, 5000, 10_000, 10_000])
  assert.equal(calls.length, 4)
})

test('pollDevice stops on a terminal error, on abort and when the code expires', async () => {
  const { fetch, calls } = mockFetch(() => json({ error: 'access_denied' }, 400))
  const client = await AllegroRestClient(config, { fetch, sleep: async () => {} })
  const device = { device_code: 'dc', expires_in: 3600, interval: 1 } as DeviceResponse
  await assert.rejects(client.pollDevice(device), { error: 'access_denied' })
  assert.equal(calls.length, 1)

  const aborted = AbortSignal.abort()
  await assert.rejects(client.pollDevice(device, { signal: aborted }), { error: 'aborted' })

  let t = 0
  const pending = mockFetch(() => json({ error: 'authorization_pending' }, 400))
  const slow = await AllegroRestClient(config, {
    fetch: pending.fetch,
    now: () => t,
    sleep: async (ms) => void (t += ms),
  })
  await assert.rejects(slow.pollDevice({ ...device, expires_in: 3 }), { error: 'expired_token' })
  assert.equal(pending.calls.length, 3)
})
