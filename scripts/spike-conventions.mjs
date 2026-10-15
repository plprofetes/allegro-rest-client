// SPIKE: finds out how the Allegro sandbox behaves beyond what the OpenAPI spec says (headers, error shapes,
// content negotiation, rate limit signals, User-Agent handling, how it treats the token request variants).
// Read-only and gentle: ~60 requests, no write access (an application token cannot modify anything).
// Output: one JSON line per probe plus a header table between SPIKE-REPORT markers. Secrets are redacted.
//   ALLEGRO_CLIENT_ID=... ALLEGRO_CLIENT_SECRET=... node scripts/spike-conventions.mjs
import { writeFileSync } from 'node:fs'

const ID = process.env.ALLEGRO_CLIENT_ID
const SECRET = process.env.ALLEGRO_CLIENT_SECRET
if (!ID || !SECRET) {
  console.error('Set ALLEGRO_CLIENT_ID and ALLEGRO_CLIENT_SECRET (sandbox device application).')
  process.exit(1)
}

const AUTH = 'https://allegro.pl.allegrosandbox.pl'
const API = 'https://api.allegro.pl.allegrosandbox.pl'
const UPLOAD = 'https://upload.allegro.pl.allegrosandbox.pl'
const basic = `Basic ${Buffer.from(`${ID}:${SECRET}`).toString('base64')}`
const PUBLIC = 'application/vnd.allegro.public.v1+json'

const SENSITIVE_HEADER = /^(authorization|set-cookie|cookie|proxy-authorization)$/i
const SENSITIVE_VALUE = /("(?:access_token|refresh_token|device_code|user_code|id_token|jti)"\s*:\s*")[^"]*"/gi
const SIGNAL_HEADER =
  /trace|request-?id|correlation|rate|limit|remaining|reset|quota|retry|deprecat|sunset|warning|link|version|x-/i

const records = []

const redact = (text) =>
  text.replace(SENSITIVE_VALUE, '$1<redacted>"').replaceAll(ID, '<client_id>').replaceAll(SECRET, '<secret>')

async function probe(group, name, url, init = {}) {
  const started = performance.now()
  const rec = {
    group,
    name,
    method: init.method ?? 'GET',
    url: url.replace(API, '<api>').replace(AUTH, '<auth>').replace(UPLOAD, '<upload>'),
  }
  try {
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15000), ...init })
    const text = await res.text()
    const headers = {}
    for (const [k, v] of res.headers) headers[k] = SENSITIVE_HEADER.test(k) ? '<redacted>' : redact(v)
    Object.assign(rec, {
      status: res.status,
      ms: Math.round(performance.now() - started),
      headers,
      bodyLength: text.length,
    })
    const type = res.headers.get('content-type') ?? ''
    if (/json/i.test(type) && text) {
      try {
        const json = JSON.parse(text)
        rec.bodyKeys = Array.isArray(json) ? ['<array>'] : Object.keys(json)
      } catch {
        rec.bodyKeys = ['<invalid json>']
      }
    }
    rec.body = redact(text).slice(0, 400)
    rec.rawText = text
  } catch (e) {
    rec.error = String(e.cause?.code ?? e.message)
  }
  records.push(rec)
  console.log(JSON.stringify({ ...rec, rawText: undefined }))
  return rec
}

const form = (params) => ({
  method: 'POST',
  headers: { authorization: basic, 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(params),
})

// ---- 1. token endpoint
const device = await probe('token', 'device-code request', `${AUTH}/auth/oauth/device`, form({ client_id: ID }))
const deviceCode = device.rawText && JSON.parse(device.rawText).device_code
await probe(
  'token',
  'unapproved device code (form)',
  `${AUTH}/auth/oauth/token`,
  form({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: deviceCode ?? 'x' }),
)
await probe(
  'token',
  'unapproved device code (query)',
  `${AUTH}/auth/oauth/token?grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code&device_code=${deviceCode ?? 'x'}`,
  { method: 'POST', headers: { authorization: basic } },
)
const cc = await probe(
  'token',
  'client_credentials (form)',
  `${AUTH}/auth/oauth/token`,
  form({ grant_type: 'client_credentials' }),
)
await probe('token', 'client_credentials wrong secret', `${AUTH}/auth/oauth/token`, {
  ...form({ grant_type: 'client_credentials' }),
  headers: {
    authorization: `Basic ${Buffer.from(`${ID}:wrong`).toString('base64')}`,
    'content-type': 'application/x-www-form-urlencoded',
  },
})
await probe('token', 'client_credentials credentials in body, no Authorization header', `${AUTH}/auth/oauth/token`, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'client_credentials', client_id: ID, client_secret: SECRET }),
})
await probe('token', 'client_credentials, no credentials at all', `${AUTH}/auth/oauth/token`, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'client_credentials' }),
})
for (const [name, extra] of [
  ['redirect_uri omitted', {}],
  ['redirect_uri empty', { redirect_uri: '' }],
  ['redirect_uri "undefined" (the 1.x bug)', { redirect_uri: 'undefined' }],
]) {
  await probe(
    'token',
    `bogus refresh token, ${name}`,
    `${AUTH}/auth/oauth/token`,
    form({ grant_type: 'refresh_token', refresh_token: 'bogus', ...extra }),
  )
}
await probe('token', 'GET on the token endpoint', `${AUTH}/auth/oauth/token`, { headers: { authorization: basic } })

// application token (metadata only, the token itself is never printed)
let appToken = 'invalid-token'
if (cc.status === 200 && cc.rawText) {
  const t = JSON.parse(cc.rawText)
  appToken = t.access_token
  const claims = (() => {
    try {
      return JSON.parse(Buffer.from(appToken.split('.')[1], 'base64url').toString())
    } catch {
      return null
    }
  })()
  console.log(
    JSON.stringify({
      group: 'app-token',
      keys: Object.keys(t),
      token_type: t.token_type,
      expires_in: t.expires_in,
      scope: t.scope,
      jwtClaimNames: claims && Object.keys(claims),
      jwtLifetimeSeconds: claims?.exp && claims?.iat ? claims.exp - claims.iat : undefined,
    }),
  )
}
const bearer = { authorization: `Bearer ${appToken}` }

// ---- 2. API, Accept negotiation
for (const accept of [
  PUBLIC,
  'application/vnd.allegro.beta.v1+json',
  'application/json',
  '*/*',
  'text/html',
  'application/vnd.allegro.public.v2+json',
  'application/vnd.allegro.public.v1+xml',
]) {
  await probe('accept', `GET /sale/categories, Accept: ${accept}`, `${API}/sale/categories`, {
    headers: { ...bearer, accept },
  })
}

// ---- 3. API, errors and auth variants
const get = (group, name, path, headers = {}, init = {}) =>
  probe(group, name, `${API}${path}`, { headers: { accept: PUBLIC, ...headers }, ...init })
await get('errors', 'unknown category', '/sale/categories/does-not-exist', bearer)
await get('errors', 'unknown path', '/nope', bearer)
await get('errors', 'root', '/', bearer)
await get('errors', 'trailing slash', '/sale/categories/', bearer)
await get('errors', 'unknown query parameter', '/sale/categories?unknown=1', bearer)
await get('auth', '/me with application token', '/me', bearer)
await get('auth', '/me without Authorization', '/me')
await get('auth', '/me with invalid bearer', '/me', { authorization: 'Bearer invalid' })
await get('auth', '/me with Basic instead of Bearer', '/me', { authorization: basic })
await get('auth', '/sale/categories without Authorization', '/sale/categories')
await get('methods', 'HEAD /sale/categories', '/sale/categories', bearer, { method: 'HEAD' })
await get('methods', 'OPTIONS /sale/categories', '/sale/categories', bearer, { method: 'OPTIONS' })
await get('methods', 'DELETE /sale/categories', '/sale/categories', bearer, { method: 'DELETE' })

// ---- 4. content type on a write endpoint (application token has no write access, so nothing can be created)
for (const [name, type, body] of [
  ['no content type', undefined, Buffer.from('{}')],
  ['application/json', 'application/json', '{}'],
  [PUBLIC, PUBLIC, '{}'],
  ['text/plain', 'text/plain', '{}'],
  [`${PUBLIC} with malformed JSON`, PUBLIC, '{not json'],
]) {
  await get(
    'content-type',
    `POST /sale/offers, Content-Type: ${name}`,
    '/sale/offers',
    { ...bearer, ...(type ? { 'content-type': type } : {}) },
    { method: 'POST', body },
  )
}

// ---- 5. User-Agent handling
for (const ua of ['allegro-rest-client-spike/0.1', undefined, '', 'curl/8.0']) {
  const headers = { ...bearer }
  if (ua !== undefined) headers['user-agent'] = ua
  await get(
    'user-agent',
    `GET /sale/categories, User-Agent: ${ua === undefined ? '<fetch default>' : JSON.stringify(ua)}`,
    '/sale/categories',
    headers,
  )
}

// ---- 6. upload host (anonymous)
await probe('upload', 'GET upload host root', `${UPLOAD}/`)
await probe('upload', 'POST /sale/images without Authorization', `${UPLOAD}/sale/images`, {
  method: 'POST',
  headers: { 'content-type': 'image/png' },
  body: Buffer.from([0x89, 0x50]),
})

// ---- 7. a short burst, to see rate limit signals (12 sequential requests, no parallelism)
for (let i = 1; i <= 12; i++) await get('burst', `burst ${i}/12`, '/sale/categories', bearer)

// ---- report
const table = {}
for (const r of records) {
  for (const [k, v] of Object.entries(r.headers ?? {})) {
    const row = (table[k] ??= { count: 0, samples: new Set() })
    row.count++
    if (row.samples.size < 4) row.samples.add(String(v).slice(0, 90))
  }
}
const apiRecords = records.filter((r) => r.url.startsWith('<api>'))
const dateHeader = records.find((r) => r.headers?.date)?.headers.date
console.log('SPIKE-REPORT-BEGIN')
console.log(
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      serverDateMinusLocalSeconds: dateHeader ? Math.round((Date.parse(dateHeader) - Date.now()) / 1000) : undefined,
      probes: records.length,
      statusCounts: records.reduce((m, r) => ((m[r.status ?? 'error'] = (m[r.status ?? 'error'] ?? 0) + 1), m), {}),
      headersSeenOnApi: Object.fromEntries(
        Object.entries(table)
          .filter(([k]) => apiRecords.some((r) => k in (r.headers ?? {})))
          .map(([k, v]) => [k, { count: v.count, samples: [...v.samples] }]),
      ),
      signalHeaders: Object.fromEntries(
        Object.entries(table)
          .filter(([k]) => SIGNAL_HEADER.test(k))
          .map(([k, v]) => [k, { count: v.count, samples: [...v.samples] }]),
      ),
    },
    null,
    1,
  ),
)
console.log('SPIKE-REPORT-END')
writeFileSync(
  'spike-report.json',
  JSON.stringify(
    records.map((r) => ({ ...r, rawText: undefined })),
    null,
    1,
  ),
)
