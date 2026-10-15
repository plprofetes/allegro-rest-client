import { deviceRequest, expectObject, tokenRequest, type TokenEndpoint } from './auth'
import { buildRequest, send, type SendSpec, type TransportDeps, type Urls } from './http'
import { toClassError } from './errors'
import { decodeJwtPayload, getExpiresInHours } from './helpers'
import { defaultPolicy } from './policy'
import type {
  AllegroClient,
  AuthResponse,
  ClientConfig,
  ClientHooks,
  ClientOptions,
  DeviceResponse,
  PaginateOptions,
  RequestOptions,
  TokenStorage,
} from './types'

const sleepDefault = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function memoryStorage(): TokenStorage {
  const store = new Map<string, AuthResponse>()
  return {
    get: (account) => store.get(account),
    set: (account, tokens) => {
      store.set(account, tokens)
    },
  }
}

type Level = 'debug' | 'info' | 'warn'
type Log = (level: Level, message: string, fields?: Record<string, unknown>) => void

function loggerHooks(log: Log): ClientHooks {
  return {
    onRequest: (e) =>
      log('debug', `request: ${e.method} ${e.url} (attempt ${e.attempt})`, {
        method: e.method,
        url: e.url,
        kind: e.kind,
        attempt: e.attempt,
      }),
    onRetry: (e) =>
      log('warn', `retrying ${e.method} ${e.url} in ${e.delayMs}ms`, {
        method: e.method,
        url: e.url,
        delayMs: e.delayMs,
      }),
  }
}

function mergeHooks(...all: ClientHooks[]): ClientHooks {
  return {
    onRequest: (e) => all.forEach((h) => h.onRequest?.(e)),
    onResponse: (e) => all.forEach((h) => h.onResponse?.(e)),
    onError: (e) => all.forEach((h) => h.onError?.(e)),
    onRetry: (e) => all.forEach((h) => h.onRetry?.(e)),
  }
}

async function AllegroRestClient(config: ClientConfig, options: ClientOptions = {}): Promise<AllegroClient> {
  const sandbox = options.sandbox === true
  const baseUrl = sandbox ? 'https://allegro.pl.allegrosandbox.pl' : 'https://allegro.pl'
  const urls: Urls = {
    api: sandbox ? 'https://api.allegro.pl.allegrosandbox.pl' : 'https://api.allegro.pl',
    upload: sandbox ? 'https://upload.allegro.pl.allegrosandbox.pl' : 'https://upload.allegro.pl',
  }
  const oauthUser = Buffer.from(`${config.client_id}:${config.client_secret}`).toString('base64')
  const account = options.account || 'default'
  const now = options.now ?? Date.now
  const refreshThresholdHours = options.refreshThresholdHours ?? 1
  const policy = options.policy ?? defaultPolicy
  const storage = options.storage ?? memoryStorage()
  const prefix = `app_name: ${config.app_name}, account: ${account}`
  const logger = options.logger
  const emit: Log = (level, message, fields = {}) => {
    if (typeof logger === 'object') logger[level]({ app_name: config.app_name, account, ...fields }, message)
    else if (logger === true) console[level](`${prefix}, ${message}`)
  }
  const log = (message: string) => emit('info', message)
  const deps: TransportDeps = {
    fetch: options.fetch,
    hooks: mergeHooks(options.hooks ?? {}, logger ? loggerHooks(emit) : {}),
    sleep: options.sleep ?? sleepDefault,
    now,
  }
  const endpoint: TokenEndpoint = { baseUrl, oauthUser, style: options.tokenParams ?? 'form' }

  const defaults = new Headers()
  if (options.userAgent) defaults.set('user-agent', options.userAgent)
  for (const [name, value] of Object.entries(options.defaultHeaders ?? {})) defaults.set(name, value)

  let tokens: AuthResponse | null = (await storage.get(account)) || null

  const storeTokens = async (authTokens: AuthResponse): Promise<void> => {
    await storage.set(account, authTokens)
    tokens = authTokens
  }

  const tokenCall = async (spec: Omit<SendSpec, 'policy' | 'kind'>): Promise<unknown> => {
    const headers = new Headers(defaults)
    spec.headers.forEach((value, name) => headers.set(name, value))
    return send(deps, { ...spec, headers, kind: 'token', policy })
  }

  const obtainTokens = async (
    params: Record<string, string | undefined>,
    extra: Partial<AuthResponse> = {},
  ): Promise<AuthResponse> => {
    const response = expectObject<AuthResponse>(await tokenCall(tokenRequest(endpoint, params)), 'access_token')
    const authTokens: AuthResponse = { ...response, created_at: Math.ceil(now() / 1000), ...extra }
    await storeTokens(authTokens)
    return authTokens
  }

  const getSellerId = (): string | null => {
    const decoded = tokens?.access_token ? decodeJwtPayload(tokens.access_token) : null
    return (decoded && decoded.user_name) || null
  }

  const authorizeApp = async (): Promise<AuthResponse> => {
    log('requesting application token...')
    return obtainTokens({ grant_type: 'client_credentials' }, { grant: 'client_credentials' })
  }

  const refresh = async (): Promise<AuthResponse> => {
    if (!tokens || !tokens.refresh_token) {
      throw {
        error: 'missing_refresh_token',
        error_description: 'Refresh token is missing or not stored in the app.',
      }
    }
    log('refreshing tokens...')
    return obtainTokens({
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
      redirect_uri: config.url_redirect,
    })
  }

  const bindApp = async (): Promise<DeviceResponse> => {
    log('binding app...')
    return expectObject<DeviceResponse>(await tokenCall(deviceRequest(endpoint, config.client_id)), 'device_code')
  }

  const authorizeDevice = async (device_code: string): Promise<AuthResponse> => {
    log('authorizing device...')
    return obtainTokens({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code,
    })
  }

  const getAuthorizationUrl = (opts: { state?: string; scope?: string[] } = {}): string => {
    if (!config.url_redirect) {
      throw { error: 'invalid_option', error_description: 'getAuthorizationUrl needs "url_redirect" in the config.' }
    }
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: config.client_id,
      redirect_uri: config.url_redirect,
    })
    if (opts.state) params.set('state', opts.state)
    if (opts.scope?.length) params.set('scope', opts.scope.join(' '))
    return `${baseUrl}/auth/oauth/authorize?${params}`
  }

  const pollDevice = async (device: DeviceResponse, opts: { signal?: AbortSignal } = {}): Promise<AuthResponse> => {
    const deadline = now() + device.expires_in * 1000
    let intervalMs = (device.interval || 5) * 1000
    for (;;) {
      if (opts.signal?.aborted) throw { error: 'aborted', error_description: 'Polling was aborted.' }
      if (now() >= deadline) throw { error: 'expired_token', error_description: 'The device code expired.' }
      await deps.sleep(intervalMs)
      try {
        return await authorizeDevice(device.device_code)
      } catch (err) {
        const code = (err as { error?: string } | null)?.error
        if (code === 'slow_down') intervalMs += 5000
        else if (code !== 'authorization_pending') throw err
      }
    }
  }

  const authorizeWeb = async (code: string): Promise<AuthResponse> => {
    log('authorizing web...')
    return obtainTokens({
      grant_type: 'authorization_code',
      code,
      redirect_uri: config.url_redirect,
    })
  }

  const makeRequest = async <T = any>(endpointPath: string, opts: RequestOptions = {}): Promise<T> => {
    if (logger) emit('debug', `tokens expire in ${getExpiresInHours(tokens, now()).toFixed(2)} hours`)
    if (tokens && refreshThresholdHours > 0 && getExpiresInHours(tokens, now()) < refreshThresholdHours) {
      if (tokens.grant === 'client_credentials') await authorizeApp()
      else if (tokens.refresh_token) await refresh()
    }
    if (!tokens || !tokens.access_token) {
      throw {
        error: 'missing_access_token',
        error_description: 'Access token is missing or not stored in the app.',
      }
    }
    const built = buildRequest(endpointPath, opts, urls, tokens.access_token, defaults)
    return (await send(deps, { ...built, kind: 'api', policy: built.policy ?? policy })) as T
  }

  async function* paginate<T = any>(path: string, opts: PaginateOptions = {}): AsyncGenerator<T, void, undefined> {
    const { itemsKey, maxItems = Infinity, ...rest } = opts
    const limit = Number(rest.qs?.limit ?? 100)
    let offset = Number(rest.qs?.offset ?? 0)
    let yielded = 0
    while (yielded < maxItems) {
      const page = await makeRequest<Record<string, unknown>>(path, { ...rest, qs: { ...rest.qs, limit, offset } })
      const arrays = itemsKey
        ? [itemsKey]
        : Object.keys(page ?? {}).filter((key) => Array.isArray((page as Record<string, unknown>)[key]))
      const items = arrays.length === 1 ? (page as Record<string, unknown>)[arrays[0]] : undefined
      if (!Array.isArray(items)) {
        throw {
          error: 'invalid_response',
          error_description: itemsKey
            ? `Response has no array "${itemsKey}".`
            : 'Cannot tell which response property holds the items; pass "itemsKey".',
        }
      }
      for (const item of items) {
        if (yielded++ >= maxItems) return
        yield item as T
      }
      if (items.length < limit) return
      offset += items.length
    }
  }

  const classErrors = options.errorMode === 'class'
  const guard = <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
    classErrors
      ? async (...args: A): Promise<R> => {
          try {
            return await fn(...args)
          } catch (err) {
            throw toClassError(err)
          }
        }
      : fn
  const guardedPaginate = classErrors
    ? async function* <T = any>(path: string, opts?: PaginateOptions): AsyncGenerator<T, void, undefined> {
        try {
          yield* paginate<T>(path, opts)
        } catch (err) {
          throw toClassError(err)
        }
      }
    : paginate
  const request = guard(makeRequest)

  const withMethod =
    (method: string) =>
    <T = any>(path: string, opts?: RequestOptions) =>
      request<T>(path, { ...opts, method })

  return {
    bindApp: config.type === 'device' ? guard(bindApp) : undefined,
    authorizeApp: guard(authorizeApp),
    getAuthorizationUrl: classErrors
      ? (opts) => {
          try {
            return getAuthorizationUrl(opts)
          } catch (err) {
            throw toClassError(err)
          }
        }
      : getAuthorizationUrl,
    pollDevice: guard(pollDevice),
    authorize: guard(config.type === 'device' ? authorizeDevice : authorizeWeb),
    getAccount: (): string => account,
    getSellerId,
    getExpiresInHours: (): string => getExpiresInHours(tokens, now()).toFixed(2),
    paginate: guardedPaginate,
    request,
    get: withMethod('GET'),
    post: withMethod('POST'),
    put: withMethod('PUT'),
    patch: withMethod('PATCH'),
    delete: withMethod('DELETE'),
  }
}

export { AllegroRestClient }
export { defaultPolicy, retry429Policy, transientRetryPolicy, parseRetryAfter } from './policy'
export type { RetryOptions, TransientRetryOptions } from './policy'
export { AllegroApiError, isAllegroError, isTransportError } from './errors'
export type {
  AllegroClient,
  AuthResponse,
  ClientConfig,
  ClientHooks,
  ClientOptions,
  DeviceResponse,
  Error,
  Logger,
  Errors,
  OAuthError,
  PaginateOptions,
  PolicyContext,
  PolicyDecision,
  RequestInfo,
  RequestOptions,
  ResponsePolicy,
  TokenStorage,
} from './types'
