import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as root from '../src'
import * as testing from '../src/testing'

// The public runtime surface. Adding or removing an export must be a conscious change (and a semver decision).
test('public runtime exports are exactly the documented ones', () => {
  assert.deepEqual(Object.keys(root).sort(), [
    'AllegroApiError',
    'AllegroRestClient',
    'defaultPolicy',
    'isAllegroError',
    'isTransportError',
    'parseRetryAfter',
    'retry429Policy',
    'transientRetryPolicy',
  ])
  assert.deepEqual(Object.keys(testing).sort(), ['mockAllegro'])
})
