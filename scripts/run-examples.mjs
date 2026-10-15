// Runs every examples/NN-*.mts offline (no credentials, no network) and fails if any exits non-zero.
// The examples import the package by name, which resolves to the built `dist/`: run `npm run build` first
// (`npm run examples` does).
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'

const dir = new URL('../examples/', import.meta.url)
const files = readdirSync(dir)
  .filter((f) => /^\d\d-.*\.mts$/.test(f))
  .sort()
const verbose = process.argv.includes('-v')
let failed = 0
for (const file of files) {
  const env = { ...process.env }
  delete env.LIVE
  const result = spawnSync(process.execPath, [`examples/${file}`], { encoding: 'utf8', env })
  const ok = result.status === 0
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${file}`)
  if (!ok || verbose) console.log(result.stdout + result.stderr)
  if (!ok) failed++
}
if (failed) {
  console.error(`${failed} of ${files.length} examples failed`)
  process.exit(1)
}
console.log(`${files.length} examples ran offline`)
