// The generated API types are a hand-off file for consumers (`allegro-rest-client/api-types`); tsc does not emit .d.ts inputs.
import { copyFileSync, mkdirSync } from 'node:fs'

mkdirSync(new URL('../dist/generated/', import.meta.url), { recursive: true })
copyFileSync(
  new URL('../src/generated/api.d.ts', import.meta.url),
  new URL('../dist/generated/api.d.ts', import.meta.url),
)
