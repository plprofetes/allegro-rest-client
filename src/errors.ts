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

/**
 * Opt-in (`errorMode: 'class'`) replacement for the plain rejection objects: a real `Error` with a stack, carrying the
 * same fields (`error`/`error_description` or `errors`) plus the HTTP details.
 */
export class AllegroApiError extends Error {
  /** OAuth / library error code (`invalid_grant`, `request_err`, `http_error`, ...). Absent on Allegro API errors. */
  readonly error?: string
  readonly error_description?: unknown
  /** Allegro API error list. Absent on OAuth and library errors. */
  readonly errors?: Errors['errors']
  readonly status?: number
  readonly headers?: Headers
  readonly body?: string
  /** Allegro's `trace-id` response header: quote it when contacting support. */
  readonly requestId?: string

  constructor(source: OAuthError | Errors) {
    const s = source as Partial<OAuthError & Errors> & ErrorMeta
    const first = s.errors?.[0]
    super(
      first
        ? `${first.code ?? 'ERROR'}: ${first.userMessage ?? first.message ?? ''}`.trim()
        : `${s.error}${s.error_description ? `: ${String(s.error_description)}` : ''}`,
      s.error_description instanceof Error ? { cause: s.error_description } : undefined,
    )
    this.name = 'AllegroApiError'
    this.error = s.error
    this.error_description = s.error_description
    this.errors = s.errors
    this.status = s.status
    this.headers = s.headers
    this.body = s.body
    this.requestId = s.headers?.get('trace-id') ?? undefined
  }
}

/** Plain Allegro rejections become `AllegroApiError`; anything else (a custom policy's own error, a real Error) is left alone. */
export function toClassError(err: unknown): unknown {
  if (err instanceof Error || !isAllegroError(err)) return err
  return new AllegroApiError(err)
}

export function isAllegroError(value: unknown): value is OAuthError | Errors {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return typeof v.error === 'string' || Array.isArray(v.errors)
}

export function isTransportError(value: unknown): value is OAuthError {
  return typeof value === 'object' && value !== null && (value as OAuthError).error === 'request_err'
}
