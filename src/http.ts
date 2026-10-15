import { transportError } from './errors'
import type {
  ClientHooks,
  PolicyDecision,
  RequestHost,
  RequestInfo,
  RequestKind,
  RequestOptions,
  ResponsePolicy,
} from './types'

type BodyInit = NonNullable<RequestInit['body']>

export const DEFAULT_ACCEPT = 'application/vnd.allegro.public.v1+json'

export interface Urls {
  api: string
  upload: string
}

export interface TransportDeps {
  fetch?: typeof fetch
  hooks: ClientHooks
  sleep: (ms: number) => Promise<void>
  now: () => number
}

export interface SendSpec {
  method: string
  url: string
  headers: Headers
  body?: BodyInit | null
  kind: RequestKind
  policy: ResponsePolicy
  raw?: boolean
  timeout?: number
  signal?: AbortSignal
}

/** `request` options that change semantics and have no equivalent here. */
const UNSUPPORTED = [
  'jar',
  'auth',
  'proxy',
  'agent',
  'pool',
  'encoding',
  'useQuerystring',
  'qsStringifyOptions',
  'formData',
  'multipart',
  'baseUrl',
  'uri',
  'url',
  'followRedirect',
  'followAllRedirects',
  'strictSSL',
  'forever',
  'callback',
]

const IDEMPOTENT = new Set(['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS'])

const bad = (error: string, error_description: string) => ({ error, error_description })

function isStream(body: unknown): body is ReadableStream {
  return typeof ReadableStream !== 'undefined' && body instanceof ReadableStream
}

function appendQuery(url: string, qs: Record<string, unknown> | undefined): string {
  if (!qs) return url
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(qs)) {
    const items = Array.isArray(value) ? value : [value]
    for (const item of items) {
      if (item === undefined || item === null) continue
      if (item instanceof Date) params.append(key, item.toISOString())
      else if (typeof item === 'object') throw bad('invalid_option', `qs does not support nested objects ("${key}")`)
      else params.append(key, String(item))
    }
  }
  const query = params.toString()
  if (!query) return url
  return url + (url.includes('?') ? '&' : '?') + query
}

export function resolveUrl(endpoint: string, host: RequestHost | undefined, urls: Urls): string {
  if (/^https?:\/\//i.test(endpoint)) {
    // never send the bearer token to a host that is not Allegro's
    const origin = new URL(endpoint).origin
    if (origin !== urls.api && origin !== urls.upload) {
      throw bad('invalid_endpoint', `Absolute URLs must point to ${urls.api} or ${urls.upload}`)
    }
    return endpoint
  }
  return (host === 'upload' ? urls.upload : urls.api) + (endpoint.startsWith('/') ? endpoint : `/${endpoint}`)
}

export interface BuiltRequest {
  method: string
  url: string
  headers: Headers
  body?: BodyInit | null
  raw?: boolean
  timeout?: number
  signal?: AbortSignal
  policy?: ResponsePolicy
}

/** Turns an endpoint plus `request`-style options into a fetch-ready request. */
export function buildRequest(endpoint: string, opts: RequestOptions, urls: Urls, bearer: string): BuiltRequest {
  for (const key of UNSUPPORTED) {
    if (key in opts) throw bad('unsupported_option', `Option "${key}" is not supported`)
  }
  const method = (opts.method ?? 'GET').toUpperCase()
  const url = appendQuery(resolveUrl(endpoint, opts.host, urls), opts.qs)

  const headers = new Headers({ Authorization: `Bearer ${bearer}`, Accept: DEFAULT_ACCEPT })
  for (const [name, value] of Object.entries(opts.headers ?? {})) headers.set(name, value)

  const jsonBody = opts.json !== undefined && typeof opts.json !== 'boolean'
  const sources = [opts.body !== undefined, opts.form !== undefined, jsonBody].filter(Boolean).length
  if (sources > 1) throw bad('invalid_option', 'Use only one of "body", "form" and "json" as the request body')

  let body: BodyInit | null | undefined
  if (opts.form !== undefined) {
    body = new URLSearchParams(Object.entries(opts.form).map(([k, v]): [string, string] => [k, String(v)]))
    if (!headers.has('content-type')) headers.set('content-type', 'application/x-www-form-urlencoded')
  } else if (jsonBody) {
    body = Buffer.from(JSON.stringify(opts.json)) as BodyInit
    if (!headers.has('content-type')) headers.set('content-type', headers.get('accept') ?? DEFAULT_ACCEPT)
  } else if (typeof opts.body === 'string') {
    // a Buffer carries no implicit content type, unlike a string (text/plain), matching 1.x on the wire
    body = Buffer.from(opts.body) as BodyInit
  } else if (opts.body !== undefined) {
    body = opts.body as BodyInit
  }
  return { method, url, headers, body, raw: opts.raw, timeout: opts.timeout, signal: opts.signal, policy: opts.policy }
}

const safe = (fn: () => void) => {
  try {
    fn()
  } catch {
    // hooks must never break a request
  }
}

// Allegro API responses carry `trace-id` (observed on the sandbox; token endpoint responses do not have it)
const requestIdOf = (headers: Headers) => headers.get('trace-id') ?? undefined

/** Sends a request, consulting the policy after every response or failure. */
export async function send(deps: TransportDeps, spec: SendSpec): Promise<unknown> {
  const fetchImpl = deps.fetch ?? globalThis.fetch
  const stream = isStream(spec.body)
  const info: RequestInfo = {
    method: spec.method,
    url: spec.url,
    kind: spec.kind,
    idempotent: IDEMPOTENT.has(spec.method),
    replayable: !stream,
    signal: spec.signal,
  }

  for (let attempt = 1; ; attempt++) {
    const event = { method: spec.method, url: spec.url, kind: spec.kind, attempt }
    safe(() => deps.hooks.onRequest?.(event))
    const signals = [spec.signal, spec.timeout ? AbortSignal.timeout(spec.timeout) : undefined].filter(
      (s): s is AbortSignal => s !== undefined,
    )
    const init: RequestInit & { duplex?: 'half' } = {
      method: spec.method,
      headers: spec.headers,
      body: spec.body,
      signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0],
    }
    if (stream) init.duplex = 'half'

    const started = deps.now()
    let response: Response | undefined
    let error: unknown
    let failed = false
    let body: string | undefined
    let json: unknown
    try {
      response = await fetchImpl(spec.url, init)
      if (!spec.raw) {
        body = await response.text()
        if (body !== '') {
          try {
            json = JSON.parse(body)
          } catch {
            json = undefined
          }
        }
      }
    } catch (e) {
      error = e ?? new Error('request failed')
      failed = true
    }
    const durationMs = deps.now() - started
    if (failed) safe(() => deps.hooks.onError?.({ ...event, durationMs, error }))
    else if (response) {
      const status = response.status
      const requestId = requestIdOf(response.headers)
      safe(() => deps.hooks.onResponse?.({ ...event, status, durationMs, requestId }))
    }

    const decision: PolicyDecision = await (spec.policy({
      request: info,
      attempt,
      response: failed ? undefined : response,
      body: failed ? undefined : body,
      json: failed ? undefined : json,
      error: failed ? error : undefined,
    }) as Promise<PolicyDecision>)

    if (decision.action === 'retry') {
      await response?.body?.cancel().catch(() => undefined)
      safe(() => deps.hooks.onRetry?.({ ...event, delayMs: decision.delayMs }))
      await deps.sleep(decision.delayMs)
      continue
    }
    if (decision.action === 'throw') throw decision.error
    if (failed || !response) throw transportError(error)
    if (spec.raw) return response
    return json !== undefined ? json : (body ?? '')
  }
}
