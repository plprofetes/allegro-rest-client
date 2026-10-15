import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { operations, paths } from '../src/generated/api'

// These are compile-time assertions: the build fails when a spec update removes or reshapes what the
// library and its documentation rely on.
type Expect<T extends true> = T
type HasMethod<P extends keyof paths, M extends string> =
  paths[P] extends Record<M, infer Op> ? (Op extends object ? true : false) : false

export type Checks = [
  Expect<HasMethod<'/me', 'get'>>,
  Expect<HasMethod<'/sale/categories', 'get'>>,
  Expect<HasMethod<'/sale/categories/{categoryId}', 'get'>>,
  Expect<HasMethod<'/sale/images', 'post'>>,
  Expect<'meGET' extends keyof operations ? true : false>,
]

test('generated API types expose the operations the library documents', () => {
  const check: Checks = [true, true, true, true, true]
  assert.equal(check.length, 5)
})
