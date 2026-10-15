import { deviceRequest, expectObject, tokenRequest, type TokenEndpoint } from './auth'
import { buildRequest, send, type SendSpec, type TransportDeps, type Urls } from './http'
import { decodeJwtPayload, getExpiresInHours } from './helpers'
import { defaultPolicy } from './policy'
import type {
  AllegroClient,
  AuthResponse,
  ClientConfig,
  ClientHooks,
  ClientOptions,
  DeviceResponse,
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

function consoleHooks(prefix: string): ClientHooks {
  return {
    onRequest: (e) => console.debug(`${prefix}, request: ${e.method} ${e.url} (attempt ${e.attempt})`),
    onRetry: (e) => console.warn(`${prefix}, retrying ${e.method} ${e.url} in ${e.delayMs}ms`),
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
  const isLogging = options.logger === true
  const now = options.now ?? Date.now
  const refreshThresholdHours = options.refreshThresholdHours ?? 1
  const policy = options.policy ?? defaultPolicy
  const storage = options.storage ?? memoryStorage()
  const prefix = `app_name: ${config.app_name}, account: ${account}`
  const log = (message: string) => {
    if (isLogging) console.info(`${prefix}, ${message}`)
  }
  const deps: TransportDeps = {
    fetch: options.fetch,
    hooks: mergeHooks(options.hooks ?? {}, isLogging ? consoleHooks(prefix) : {}),
    sleep: options.sleep ?? sleepDefault,
    now,
  }
  const endpoint: TokenEndpoint = { baseUrl, oauthUser, style: options.tokenParams ?? 'form' }

  let tokens: AuthResponse | null = (await storage.get(account)) || null

  const storeTokens = async (authTokens: AuthResponse): Promise<void> => {
    await storage.set(account, authTokens)
    tokens = authTokens
  }

  const tokenCall = async (spec: Omit<SendSpec, 'policy' | 'kind'>): Promise<unknown> =>
    send(deps, { ...spec, kind: 'token', policy })

  const obtainTokens = async (params: Record<string, string | undefined>): Promise<AuthResponse> => {
    const response = expectObject<AuthResponse>(await tokenCall(tokenRequest(endpoint, params)), 'access_token')
    const authTokens: AuthResponse = { ...response, created_at: Math.ceil(now() / 1000) }
    await storeTokens(authTokens)
    return authTokens
  }

  const getSellerId = (): string | null => {
    const decoded = tokens?.access_token ? decodeJwtPayload(tokens.access_token) : null
    return (decoded && decoded.user_name) || null
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

  const authorizeWeb = async (code: string): Promise<AuthResponse> => {
    log('authorizing web...')
    return obtainTokens({
      grant_type: 'authorization_code',
      code,
      redirect_uri: config.url_redirect,
    })
  }

  const makeRequest = async <T = any>(endpointPath: string, opts: RequestOptions = {}): Promise<T> => {
    if (isLogging) console.debug(`tokens expire in ${getExpiresInHours(tokens, now()).toFixed(2)} hours`)
    if (
      tokens &&
      tokens.refresh_token &&
      refreshThresholdHours > 0 &&
      getExpiresInHours(tokens, now()) < refreshThresholdHours
    ) {
      await refresh()
    }
    if (!tokens || !tokens.access_token) {
      throw {
        error: 'missing_access_token',
        error_description: 'Access token is missing or not stored in the app.',
      }
    }
    const built = buildRequest(endpointPath, opts, urls, tokens.access_token)
    return (await send(deps, { ...built, kind: 'api', policy: built.policy ?? policy })) as T
  }

  const withMethod =
    (method: string) =>
    <T = any>(path: string, opts?: RequestOptions) =>
      makeRequest<T>(path, { ...opts, method })

  return {
    bindApp: config.type === 'device' ? bindApp : undefined,
    authorize: config.type === 'device' ? authorizeDevice : authorizeWeb,
    getAccount: (): string => account,
    getSellerId,
    getExpiresInHours: (): string => getExpiresInHours(tokens, now()).toFixed(2),
    request: makeRequest,
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
export { isAllegroError, isTransportError } from './errors'
export type {
  AllegroClient,
  AuthResponse,
  ClientConfig,
  ClientHooks,
  ClientOptions,
  DeviceResponse,
  Error,
  Errors,
  OAuthError,
  PolicyContext,
  PolicyDecision,
  RequestInfo,
  RequestOptions,
  ResponsePolicy,
  TokenStorage,
} from './types'
