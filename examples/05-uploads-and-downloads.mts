/**
 * Uploads and binary downloads.
 *
 *   node examples/05-uploads-and-downloads.mts        offline only: uploading would create real images on an account
 *
 * - Images and attachments are served from a DIFFERENT host (`upload.allegro.pl`): pass `host: 'upload'`.
 *   `sandbox: true` switches that host too. Absolute URLs are accepted only for Allegro's own hosts, so the
 *   bearer token cannot be sent anywhere else by mistake.
 * - `body` takes a string, Buffer/Uint8Array, Blob, FormData, URLSearchParams or a stream.
 * - The specification does not describe the image upload body, so check Allegro's guide for the formats it accepts.
 * - Binary responses (PDF labels, CSV, ZPL): `raw: true` returns the native `Response`, and `Accept` must be the
 *   media type the specification lists for that response (the vendor JSON type is wrong for them).
 */
import assert from 'node:assert/strict'
import { connect, section, show, wire } from './_client.mts'

const png = Buffer.from('89504e470d0a1a0a', 'hex') // a PNG signature stands in for real image bytes
const pdf = Buffer.from('%PDF-1.4 fake label')

let labelCalls = 0
const { client, calls } = await connect({
  'POST /sale/images': { status: 201, body: { location: 'https://a.allegroimg.com/original/abc' } },
  // first call succeeds, the second one is "unknown shipment"
  'POST /shipment-management/label': () =>
    ++labelCalls === 1
      ? { body: pdf.toString(), headers: { 'content-type': 'application/octet-stream' } }
      : { status: 404, body: 'not found', headers: { 'content-type': 'text/plain' } },
})

section('upload an image: host "upload", raw bytes, explicit Content-Type')
const image = await client.post<{ location: string }>('/sale/images', {
  host: 'upload',
  body: png,
  headers: { 'Content-Type': 'image/png' },
})
show('stored at', image.location)
show('request', wire(calls.at(-1)!).request)
assert.equal(new URL(calls.at(-1)!.url).host, 'upload.allegro.pl')
assert.equal(calls.at(-1)!.headers.get('content-type'), 'image/png')

section('download a label: raw: true gives the Response, you read it as you need')
const response = await client.post<Response>('/shipment-management/label', {
  raw: true,
  json: { shipmentIds: ['s-1'], pageSize: 'A6' },
  headers: { Accept: 'application/octet-stream' },
})
const bytes = Buffer.from(await response.arrayBuffer())
show('status', response.status)
show('content-type', response.headers.get('content-type')!)
show('bytes', bytes.length)
assert.equal(bytes.toString(), pdf.toString())
// await writeFile('label.pdf', bytes)

section('a non-2xx raw response still rejects (the body is not read in raw mode)')
const failure = await client
  .post('/shipment-management/label', {
    raw: true,
    json: { shipmentIds: ['nope'] },
    headers: { Accept: 'application/octet-stream' },
  })
  .catch((e) => e)
show('rejected with', { error: failure.error, status: failure.status })
assert.equal(failure.status, 404)
