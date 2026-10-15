import type { AuthResponse, ClientConfig } from '../src'

export interface Recorded {
  url: string
  method: string
  headers: Headers
  body: string | undefined
  rawBody: unknown
  signal: AbortSignal | null | undefined
}

type Responder = (req: Recorded, n: number) => Response | Promise<Response>

export function mockFetch(responder: Responder) {
  const calls: Recorded[] = []
  const fetchImpl = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const raw = init.body
    let body: string | undefined
    if (raw !== undefined && raw !== null) body = await new Response(raw as NonNullable<RequestInit['body']>).text()
    const req: Recorded = {
      url: String(input),
      method: init.method ?? 'GET',
      headers: new Headers(init.headers),
      body,
      rawBody: raw,
      signal: init.signal,
    }
    calls.push(req)
    return responder(req, calls.length)
  }
  return { fetch: fetchImpl as typeof fetch, calls }
}

export const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } })

export const config: ClientConfig = {
  app_name: 'test-app',
  type: 'device',
  client_id: 'client-id',
  client_secret: 'client-secret',
}

export const webConfig: ClientConfig = { ...config, type: 'web', url_redirect: 'https://example.test/cb' }

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
export const jwt = (payload: object) => `${b64({ alg: 'none' })}.${b64(payload)}.sig`

/** Tokens that are valid for `hoursLeft` more hours (default 12). */
export function tokens(hoursLeft = 12, extra: Partial<AuthResponse> = {}): AuthResponse {
  const expires_in = 43200
  return {
    access_token: jwt({ user_name: 'seller-1' }),
    refresh_token: 'refresh-1',
    token_type: 'bearer',
    expires_in,
    created_at: Math.floor(Date.now() / 1000) - expires_in + Math.round(hoursLeft * 3600),
    scope: 'allegro:api:sale:offers:read',
    jti: 'jti-1',
    ...extra,
  }
}

export function memoryStorage(initial?: AuthResponse) {
  const calls = { get: 0, set: 0 }
  let stored = initial
  return {
    calls,
    storage: {
      get(_account: string) {
        calls.get++
        return stored
      },
      set(_account: string, t: AuthResponse) {
        calls.set++
        stored = t
      },
    },
    current: () => stored,
  }
}

/** Fails the test run quickly instead of hanging forever. */
export const within = <T>(p: Promise<T>, ms = 2000): Promise<T> =>
  Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`timed out after ${ms}ms`)), ms))])
