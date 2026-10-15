/**
 * Hooks and logging: observe every request without touching the call sites.
 *
 *   node examples/08-hooks-and-logging.mts                         offline
 *   LIVE=1 node --env-file=.env examples/08-hooks-and-logging.mts  sandbox: real durations and trace-ids
 *
 * `hooks` get method, URL, kind ('api' | 'token'), attempt, and for responses status, duration and the
 * `requestId` (Allegro's trace-id). They never receive headers or tokens, and an exception inside a hook
 * cannot break a request.
 * `logger: true` is a console shortcut; a pino-style object ({ debug, info, warn }(fields, message)) receives
 * structured records. Both are built on the hooks.
 */
import assert from 'node:assert/strict'
import { connect, offlineOnly, section, show } from './_client.mts'

const timings: { url: string; status: number; ms: number; requestId?: string }[] = []
const records: { level: string; message: string; fields: Record<string, unknown> }[] = []
const log = (level: string) => (fields: Record<string, unknown>, message: string) =>
  void records.push({ level, message, fields })

const { client } = await connect(
  {
    'GET /me': { body: { id: '1' }, headers: { 'trace-id': 'abc123def4567890' } },
    'GET /sale/offers/9': {
      status: 404,
      body: { errors: [{ code: 'NotFoundException' }] },
      headers: { 'trace-id': 'fff0' },
    },
  },
  {
    hooks: {
      onResponse: (e) =>
        timings.push({
          url: new URL(e.url).pathname,
          status: e.status,
          ms: Math.round(e.durationMs),
          requestId: e.requestId,
        }),
      onError: (e) => console.log(`   transport error on ${e.method} ${e.url}`),
    },
    logger: { debug: log('debug'), info: log('info'), warn: log('warn') }, // e.g. pino()
  },
)

section('make a few calls')
await client.get('/me')
await client.get('/sale/offers/9').catch(() => undefined)

section('hooks collected the timings (feed them to your metrics)')
for (const t of timings) show(t.url, `status ${t.status}, ${t.ms} ms, trace-id ${t.requestId ?? '-'}`)
offlineOnly(() => assert.equal(timings[0].requestId, 'abc123def4567890'))

section('the logger object received structured records')
for (const r of records) show(`${r.level} ${r.message}`, r.fields)
offlineOnly(() => assert.ok(records.every((r) => !JSON.stringify(r).includes('Bearer'))))
