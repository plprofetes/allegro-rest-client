export type MaybePromise<T> = T | Promise<T>

export interface ClientConfig {
  app_name: string
  /** `'device'` (preferred) or `'web'`. Plain strings are accepted for compatibility. */
  type: 'device' | 'web' | (string & {})
  client_id: string
  client_secret: string
  url_redirect?: string
}

/** Where token endpoint parameters are sent. `form` (default) keeps secrets out of URLs. */
export type TokenParamsStyle = 'form' | 'query'

export interface ClientOptions {
  sandbox?: boolean
  /** `true` prints request/refresh info to the console. */
  logger?: boolean
  account?: string
  /** Token persistence. `get` is called once, when the client is constructed. */
  storage?: TokenStorage
  /** Custom `fetch` (proxy, keep-alive agent, test double). Defaults to the global `fetch`. */
  fetch?: typeof fetch
  /** Decides what happens after each response. Defaults to {@link defaultPolicy}. */
  policy?: ResponsePolicy
  /** Refresh tokens when less than this many hours remain. Default 1; `0` disables built-in refresh. */
  refreshThresholdHours?: number
  /** Where token endpoint parameters are sent. Default `form`. */
  tokenParams?: TokenParamsStyle
  /** Lifecycle callbacks (logging, metrics, tracing). */
  hooks?: ClientHooks
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>
  /** Injectable for tests. Milliseconds since epoch. */
  now?: () => number
}

export interface TokenStorage {
  get(account: string): MaybePromise<AuthResponse | null | undefined | void>
  set(account: string, tokens: AuthResponse): MaybePromise<unknown>
}

export interface DeviceResponse {
  device_code: string
  expires_in: number
  user_code: string
  interval: number
  verification_uri: string
  verification_uri_complete: string
}

export interface AuthResponse {
  access_token: string
  refresh_token: string
  token_type: string
  created_at?: number /* seconds since 1970 */
  expires_in: number
  scope: string
  jti: string
}

/** OAuth / transport error. Kept under its 1.x name; it shadows the global `Error` only when imported by that name. */
export interface OAuthError {
  error: string
  error_description: unknown
}
export type { OAuthError as Error }

export interface Errors {
  errors: {
    code: string
    message: string
    details: any
    path: string
    userMessage: any
  }[]
}

export type RequestHost = 'api' | 'upload'

export interface RequestOptions {
  method?: string
  headers?: Record<string, string>
  /** string, Buffer/Uint8Array, Blob, FormData, URLSearchParams or a stream. Strings are sent without an implicit content type. */
  body?: string | Uint8Array | Blob | FormData | URLSearchParams | ReadableStream
  /** Query string. Arrays become repeated keys (`a=1&a=2`); nested objects are rejected. */
  qs?: Record<string, unknown>
  /** Sent as an `application/x-www-form-urlencoded` body. */
  form?: Record<string, string | number | boolean>
  /** An object/array is sent as a JSON body (content type defaults to the `Accept` media type). `true` is accepted and ignored. */
  json?: unknown
  /** Abort the request after this many milliseconds. */
  timeout?: number
  /** Abort the request from the outside. */
  signal?: AbortSignal
  /** `upload` targets `upload.allegro.pl` (images, attachments). Default `api`. */
  host?: RequestHost
  /** Return the native `Response` (binary downloads: labels, PDFs). JSON parsing and body-based error detection are skipped. */
  raw?: boolean
  /** Overrides the client policy for this request. */
  policy?: ResponsePolicy
}

export type RequestKind = 'api' | 'token'

export interface RequestInfo {
  method: string
  url: string
  kind: RequestKind
  /** `true` for GET/HEAD/PUT/DELETE/OPTIONS. */
  idempotent: boolean
  /** `false` when the body is a one-shot stream, so the request cannot be re-sent. */
  replayable: boolean
  signal?: AbortSignal
}

export interface PolicyContext {
  request: RequestInfo
  /** 1-based. */
  attempt: number
  /** Set when a response was received. */
  response?: Response
  /** Response body text (not read in `raw` mode). */
  body?: string
  /** Parsed `body` when it is valid JSON. */
  json?: unknown
  /** Set when the transport failed (network error, timeout, abort). */
  error?: unknown
}

export type PolicyDecision =
  /** Accept the outcome: the parsed JSON (or text, or the `Response` in raw mode) is returned. */
  | { action: 'return' }
  | { action: 'retry'; delayMs: number }
  /** Reject with this error. */
  | { action: 'throw'; error: unknown }

export type ResponsePolicy = (ctx: PolicyContext) => PolicyDecision | Promise<PolicyDecision>

export interface HookEvent {
  method: string
  url: string
  kind: RequestKind
  attempt: number
}
export interface ResponseHookEvent extends HookEvent {
  status: number
  durationMs: number
  /** Allegro request/trace id header, when present. */
  requestId?: string
}
export interface ErrorHookEvent extends HookEvent {
  durationMs: number
  error: unknown
}
export interface RetryHookEvent extends HookEvent {
  delayMs: number
}

/** Credentials and tokens are never passed to hooks. */
export interface ClientHooks {
  onRequest?(event: HookEvent): void
  onResponse?(event: ResponseHookEvent): void
  onError?(event: ErrorHookEvent): void
  onRetry?(event: RetryHookEvent): void
}

export interface AllegroClient {
  /** `undefined` unless `config.type` is `'device'`. */
  bindApp: (() => Promise<DeviceResponse>) | undefined
  authorize: (codeOrDeviceCode: string) => Promise<AuthResponse>
  getAccount: () => string
  getSellerId: () => string | null
  /** Hours until the access token expires, as a string with 2 decimals. */
  getExpiresInHours: () => string
  request: <T = any>(endpoint: string, opts?: RequestOptions) => Promise<T>
  get: <T = any>(endpoint: string, opts?: RequestOptions) => Promise<T>
  post: <T = any>(endpoint: string, opts?: RequestOptions) => Promise<T>
  put: <T = any>(endpoint: string, opts?: RequestOptions) => Promise<T>
  patch: <T = any>(endpoint: string, opts?: RequestOptions) => Promise<T>
  delete: <T = any>(endpoint: string, opts?: RequestOptions) => Promise<T>
}
