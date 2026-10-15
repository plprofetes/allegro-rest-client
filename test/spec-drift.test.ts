import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

// compiled to .build/test, so the project root is two levels up
const root = join(__dirname, '..', '..')
const spec = join(root, 'spec', 'swagger.yaml')
const generated = join(root, 'src', 'generated', 'api.d.ts')

test('the Allegro specification is present (it is required, there is no fallback)', () => {
  assert.ok(existsSync(spec), 'spec/swagger.yaml is missing; restore it from git or run `npm run spec:update`')
})

test('spec.meta.json describes the committed specification', () => {
  const meta = JSON.parse(readFileSync(join(root, 'spec', 'spec.meta.json'), 'utf8'))
  assert.equal(meta.source, 'https://developer.allegro.pl/swagger.yaml')
  assert.match(meta.retrievedAt, /^\d{4}-\d{2}-\d{2}$/)
  assert.equal(meta.sha256, createHash('sha256').update(readFileSync(spec)).digest('hex'))
})

test('generated types come from exactly this specification', () => {
  const meta = JSON.parse(readFileSync(join(root, 'spec', 'spec.meta.json'), 'utf8'))
  const header = readFileSync(generated, 'utf8').slice(0, 600)
  assert.ok(header.includes(`Spec sha256: ${meta.sha256}`), 'generated header does not carry the spec sha256')
  assert.ok(header.includes(`Documentation retrieved: ${meta.retrievedAt}`))
})

test('regenerating from the specification reproduces the committed types (no drift, deterministic)', () => {
  const tools = join(root, 'tools', 'generator')
  if (!existsSync(join(tools, 'node_modules'))) {
    const install = spawnSync('npm', ['ci', '--silent'], { cwd: tools, encoding: 'utf8' })
    assert.equal(install.status, 0, `could not install the generator: ${install.stderr}`)
  }
  const run = spawnSync(process.execPath, [join(tools, 'generate.mjs'), '--check'], { cwd: root, encoding: 'utf8' })
  assert.equal(run.status, 0, run.stderr || run.stdout)
})
