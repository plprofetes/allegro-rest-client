import { httpError, invalidResponse, transportError, withMeta } from './errors'
import type { PolicyContext, PolicyDecision, ResponsePolicy } from './types'

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

/**
 * Default policy: 1.x behaviour, no retries. A response is an error when the body carries a truthy `error` or
 * `errors` field (whatever the status), or the status is not 2xx. HTTP details are attached to the error as
 * non-enumerable `status`, `headers` and `body`.
 */
export function defaultPolicy(ctx: PolicyContext): PolicyDecision {
  if (ctx.error !== undefined || !ctx.response) {
    return { action: 'throw', error: transportError(ctx.error) }
  }
  const { response, body, json } = ctx
  const meta = { status: response.status, headers: response.headers, body }
  const ok = response.ok || response.status === 304
  if (body === undefined) {
    // raw mode: the body is the caller's business
    return ok ? { action: 'return' } : { action: 'throw', error: withMeta(httpError(response.status, undefined), meta) }
  }
  if (isRecord(json) && (json.error || json.errors)) {
    return { action: 'throw', error: withMeta(json, meta) }
  }
  if (!ok) return { action: 'throw', error: withMeta(httpError(response.status, body), meta) }
  if (body !== '' && json === undefined) {
    return { action: 'throw', error: withMeta(invalidResponse('Response body is not valid JSON'), meta) }
  }
  return { action: 'return' }
}

export interface RetryOptions {
  /** Total attempts including the first one. Default 3. */
  maxAttempts?: number
  /** First backoff delay when the server gives no `Retry-After`. Default 1000 (429) / 500 (transient). */
  baseDelayMs?: number
  /** Upper bound for any delay. Default 60000. */
  maxDelayMs?: number
  /** Policy consulted when this one does not retry. Default {@link defaultPolicy}. */
  next?: ResponsePolicy
  /** Injectable for tests. Default `Math.random`. */
  random?: () => number
  /** Injectable for tests. Default `Date.now`. */
  now?: () => number
}

/** `Retry-After` as seconds or an HTTP date, in milliseconds. */
export function parseRetryAfter(value: string | null | undefined, now: number = Date.now()): number | undefined {
  if (!value) return undefined
  const trimmed = value.trim()
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000
  const at = Date.parse(trimmed)
  return Number.isNaN(at) ? undefined : Math.max(0, at - now)
}

function backoff(attempt: number, base: number, max: number, random: () => number): number {
  const exp = Math.min(max, base * 2 ** (attempt - 1))
  return Math.round(exp / 2 + (random() * exp) / 2)
}

const callerAborted = (ctx: PolicyContext) => ctx.request.signal?.aborted === true

/**
 * Retries HTTP 429 for API calls, waiting for `Retry-After` (seconds or date), else exponential backoff with
 * jitter. 429 means the request was not processed, so any method is retried.
 */
export function retry429Policy(opts: RetryOptions = {}): ResponsePolicy {
  const { maxAttempts = 3, baseDelayMs = 1000, maxDelayMs = 60000, next = defaultPolicy } = opts
  const random = opts.random ?? Math.random
  const now = opts.now ?? Date.now
  return (ctx) => {
    if (
      ctx.request.kind === 'api' &&
      ctx.response?.status === 429 &&
      ctx.attempt < maxAttempts &&
      ctx.request.replayable &&
      !callerAborted(ctx)
    ) {
      const advised = parseRetryAfter(ctx.response.headers.get('retry-after'), now())
      const delayMs = Math.min(maxDelayMs, advised ?? backoff(ctx.attempt, baseDelayMs, maxDelayMs, random))
      return { action: 'retry', delayMs }
    }
    return next(ctx)
  }
}

export interface TransientRetryOptions extends RetryOptions {
  /** Retried statuses. Default 502, 503, 504. */
  statuses?: number[]
  /** Only these methods are retried. Default: the idempotent ones (never POST/PATCH). */
  methods?: string[]
}

/** Retries transport errors and gateway statuses for idempotent API calls. */
export function transientRetryPolicy(opts: TransientRetryOptions = {}): ResponsePolicy {
  const { maxAttempts = 3, baseDelayMs = 500, maxDelayMs = 60000, next = defaultPolicy } = opts
  const statuses = opts.statuses ?? [502, 503, 504]
  const methods = opts.methods?.map((m) => m.toUpperCase())
  const random = opts.random ?? Math.random
  const now = opts.now ?? Date.now
  return (ctx) => {
    const allowed = methods ? methods.includes(ctx.request.method) : ctx.request.idempotent
    const transient = ctx.error !== undefined || (ctx.response !== undefined && statuses.includes(ctx.response.status))
    if (
      transient &&
      allowed &&
      ctx.request.kind === 'api' &&
      ctx.attempt < maxAttempts &&
      ctx.request.replayable &&
      !callerAborted(ctx)
    ) {
      const advised = parseRetryAfter(ctx.response?.headers.get('retry-after'), now())
      const delayMs = Math.min(maxDelayMs, advised ?? backoff(ctx.attempt, baseDelayMs, maxDelayMs, random))
      return { action: 'retry', delayMs }
    }
    return next(ctx)
  }
}
