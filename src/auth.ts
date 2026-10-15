import { invalidResponse } from './errors'
import type { SendSpec } from './http'
import type { TokenParamsStyle } from './types'

export interface TokenEndpoint {
  baseUrl: string
  /** base64 of `client_id:client_secret` */
  oauthUser: string
  style: TokenParamsStyle
}

type Params = Record<string, string | undefined>

function toParams(params: Params): URLSearchParams {
  const out = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) if (value !== undefined) out.append(key, value)
  return out
}

/** Request to `/auth/oauth/token`. Parameters go in a form body unless `style` is `query`. */
export function tokenRequest(endpoint: TokenEndpoint, params: Params): Omit<SendSpec, 'policy' | 'kind'> {
  const headers = new Headers({ Authorization: `Basic ${endpoint.oauthUser}` })
  const url = `${endpoint.baseUrl}/auth/oauth/token`
  if (endpoint.style === 'query') {
    return { method: 'POST', url: `${url}?${toParams(params)}`, headers }
  }
  headers.set('content-type', 'application/x-www-form-urlencoded')
  return { method: 'POST', url, headers, body: toParams(params) }
}

/** Device authorization request (`/auth/oauth/device`). */
export function deviceRequest(endpoint: TokenEndpoint, clientId: string): Omit<SendSpec, 'policy' | 'kind'> {
  const headers = new Headers({
    Authorization: `Basic ${endpoint.oauthUser}`,
    'content-type': 'application/x-www-form-urlencoded',
  })
  return {
    method: 'POST',
    url: `${endpoint.baseUrl}/auth/oauth/device`,
    headers,
    body: toParams({ client_id: clientId }),
  }
}

/** A custom policy may accept odd bodies; make sure we got what we need before using it. */
export function expectObject<T extends object>(value: unknown, requiredKey: string): T {
  if (typeof value !== 'object' || value === null || !(requiredKey in value)) {
    throw invalidResponse(`Unexpected response from the authorization server (missing "${requiredKey}")`)
  }
  return value as T
}
