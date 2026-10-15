import assert from 'node:assert/strict'
import { test } from 'node:test'
import { json, mockFetch, tokens } from './helpers'
import { decrypt, encrypt, githubVariableStorage } from './ci/storage'

const opts = { repo: 'o/r', name: 'VAR', token: 'pat', passphrase: 'k', sleep: async () => {} }

test('encrypt/decrypt round-trips and rejects a wrong key, a tampered blob and another variable name', () => {
  const blob = encrypt('{"a":1}', 'key', 'VAR')
  assert.ok(!blob.includes('"a"'))
  assert.equal(decrypt(blob, 'key', 'VAR'), '{"a":1}')
  assert.throws(() => decrypt(blob, 'other', 'VAR'), /Cannot decrypt/)
  assert.throws(() => decrypt(blob, 'key', 'OTHER'), /Cannot decrypt/)
  const flipped = blob.slice(0, -4) + (blob.endsWith('AAAA') ? 'BBBB' : 'AAAA')
  assert.throws(() => decrypt(flipped, 'key', 'VAR'), /Cannot decrypt/)
  assert.notEqual(encrypt('x', 'key', 'VAR'), encrypt('x', 'key', 'VAR'))
})

test('variable storage: set writes ciphertext only, get reads it back, missing variable reads as empty', async () => {
  let stored = ''
  const { fetch, calls } = mockFetch((req) => {
    if (req.method === 'GET') return stored ? json({ value: stored }) : json({}, 404)
    stored = JSON.parse(req.body!).value
    return new Response(null, { status: 204 })
  })
  const storage = githubVariableStorage({ ...opts, fetch })
  assert.equal(await storage.get('a'), undefined)
  const t = tokens()
  await storage.set('a', t)
  assert.ok(!stored.includes(t.refresh_token))
  assert.equal(calls[1].method, 'PATCH')
  assert.equal(calls[1].headers.get('authorization'), 'Bearer pat')
  assert.deepEqual(await storage.get('a'), t)
})

test('variable storage: creates the variable when PATCH says 404, retries transient failures, then fails loudly', async () => {
  const methods: string[] = []
  const { fetch } = mockFetch((req) => {
    methods.push(req.method)
    if (req.method === 'PATCH') return json({}, 404)
    return new Response(null, { status: methods.filter((m) => m === 'POST').length < 2 ? 502 : 201 })
  })
  await githubVariableStorage({ ...opts, fetch }).set('a', tokens())
  assert.deepEqual(methods, ['PATCH', 'POST', 'PATCH', 'POST'])

  const failing = mockFetch(() => json({}, 500))
  await assert.rejects(
    async () => githubVariableStorage({ ...opts, fetch: failing.fetch }).set('a', tokens()),
    /chain is broken/,
  )
  assert.equal(failing.calls.length, 5)

  const denied = mockFetch(() => json({}, 403))
  await assert.rejects(
    async () => githubVariableStorage({ ...opts, fetch: denied.fetch }).set('a', tokens()),
    /HTTP 403/,
  )
  assert.equal(denied.calls.length, 1)
})
