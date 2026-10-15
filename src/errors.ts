import type { Errors, OAuthError } from './types'

interface ErrorMeta {
  status?: number
  headers?: Headers
  body?: string
}

/**
 * Attaches HTTP details to an error without changing its enumerable keys, so `Object.keys(err)` and
 * `JSON.stringify(err)` stay as they were in 1.x. The properties are lost on spread or structured clone.
 */
export function withMeta<T extends object>(err: T, meta: ErrorMeta): T {
  for (const [key, value] of Object.entries(meta)) {
    if (value !== undefined)
      Object.defineProperty(err, key, { value, enumerable: false, configurable: true, writable: true })
  }
  return err
}

/** Transport failure (network, timeout, abort). `error_description` is the underlying error, e.g. one carrying `.code`. */
export function transportError(err: unknown): OAuthError {
  const cause = err instanceof Error && err.cause instanceof Error ? err.cause : undefined
  return { error: 'request_err', error_description: cause ?? err }
}

export function httpError(status: number, body: string | undefined): OAuthError {
  return { error: 'http_error', error_description: `HTTP ${status}` + (body ? `: ${body.slice(0, 200)}` : '') }
}

export function invalidResponse(reason: string): OAuthError {
  return { error: 'invalid_response', error_description: reason }
}

export function isAllegroError(value: unknown): value is OAuthError | Errors {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return typeof v.error === 'string' || Array.isArray(v.errors)
}

export function isTransportError(value: unknown): value is OAuthError {
  return typeof value === 'object' && value !== null && (value as OAuthError).error === 'request_err'
}
