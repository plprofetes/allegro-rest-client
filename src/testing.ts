import { AllegroRestClient } from './index'
import type { AllegroClient, AuthResponse, ClientConfig, ClientOptions } from './types'

/** What a fake route answers. `body` objects are sent as JSON. */
export interface MockReply {
  status?: number
  body?: unknown
  headers?: Record<string, string>
}

export interface MockRequest {
  method: string
  url: string
  /** Path without host and query. */
  path: string
  query: URLSearchParams
  headers: Headers
  /** Request body as text, if there was one. */
  body?: string
}

export type MockRoute = MockReply | ((request: MockRequest) => MockReply | Promise<MockReply>)

const jsonResponse = ({ status = 200, body, headers }: MockReply): Response => {
  const isText = typeof body === 'string'
  return new Response(body === undefined || status === 204 ? null : isText ? body : JSON.stringify(body), {
    status,
    headers: { ...(body !== undefined && !isText ? { 'content-type': 'application/json' } : {}), ...headers },
  })
}

/**
 * A fake `fetch` for tests, keyed by `'METHOD /path'` (no host, no query). Unmatched requests answer 404 with an
 * Allegro-style error naming the missing route, and are still recorded in `calls`.
 */
export function mockAllegro(routes: Record<string, MockRoute>) {
  const calls: MockRequest[] = []
  const fetchImpl = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input))
    const method = (init.method ?? 'GET').toUpperCase()
    const body =
      init.body === undefined || init.body === null
        ? undefined
        : await new Response(init.body as NonNullable<RequestInit['body']>).text()
    const request: MockRequest = {
      method,
      url: url.toString(),
      path: url.pathname,
      query: url.searchParams,
      headers: new Headers(init.headers),
      body,
    }
    calls.push(request)
    const route = routes[`${method} ${url.pathname}`]
    if (!route) {
      return jsonResponse({
        status: 404,
        body: { errors: [{ code: 'MOCK_ROUTE_MISSING', message: `No mock route for ${method} ${url.pathname}` }] },
      })
    }
    return jsonResponse(typeof route === 'function' ? await route(request) : route)
  }

  /** Tokens that stay valid for a day, so the client never tries to refresh. */
  const tokens: AuthResponse = {
    access_token: 'test-access-token',
    refresh_token: 'test-refresh-token',
    token_type: 'bearer',
    expires_in: 86400,
    created_at: Math.floor(Date.now() / 1000),
    scope: '',
    jti: 'test',
  }

  return {
    fetch: fetchImpl as typeof fetch,
    calls,
    /** A client wired to this mock and already authorized. */
    client: (options: ClientOptions = {}, config?: Partial<ClientConfig>): Promise<AllegroClient> =>
      AllegroRestClient(
        { app_name: 'test', type: 'device', client_id: 'id', client_secret: 'secret', ...config },
        { storage: { get: () => tokens, set: () => {} }, ...options, fetch: fetchImpl as typeof fetch },
      ),
  }
}
