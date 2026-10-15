// Downloads the official Allegro OpenAPI specification into spec/ and records when it was retrieved.
// Fails loudly when the download fails; the committed copy is left untouched in that case.
import { createHash } from 'node:crypto'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'

const SOURCE = 'https://developer.allegro.pl/swagger.yaml'
const specUrl = new URL('../spec/swagger.yaml', import.meta.url)
const metaUrl = new URL('../spec/spec.meta.json', import.meta.url)
const tmpUrl = new URL('../spec/swagger.yaml.download', import.meta.url)

const res = await fetch(SOURCE).catch((e) => {
  console.error(`spec:update: cannot reach ${SOURCE}: ${e.cause?.code ?? e.message}`)
  process.exit(1)
})
if (!res.ok) {
  console.error(`spec:update: ${SOURCE} answered HTTP ${res.status}`)
  process.exit(1)
}
const text = await res.text()
if (!/^openapi:\s*3/m.test(text) || !text.includes('paths:')) {
  console.error('spec:update: the download does not look like an OpenAPI 3 document; keeping the committed copy')
  process.exit(1)
}

const sha256 = createHash('sha256').update(text).digest('hex')
const previous = JSON.parse(readFileSync(metaUrl, 'utf8'))
writeFileSync(tmpUrl, text)
renameSync(tmpUrl, specUrl)
writeFileSync(
  metaUrl,
  JSON.stringify({ source: SOURCE, retrievedAt: new Date().toISOString().slice(0, 10), sha256 }, null, 2) + '\n',
)
console.log(
  sha256 === previous.sha256
    ? 'spec:update: no change'
    : 'spec:update: specification changed. Run `npm run generate` and commit spec/ and src/generated/.',
)
