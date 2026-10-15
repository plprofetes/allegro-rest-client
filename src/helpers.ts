import type { AuthResponse } from './types'

export function decodeJwtPayload(token: string | undefined): Record<string, any> | null {
  const part = token?.split('.')[1]
  if (!part) return null
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))
  } catch {
    return null
  }
}

/**
 * Hours until the access token expires. `0` when there are no tokens.
 * Uses `created_at + expires_in`, falling back to the JWT `exp` claim; when neither is known the expiry is
 * unknown and `Infinity` is returned (so built-in refresh does not fire on every request).
 */
export const getExpiresInHours = (tokens: AuthResponse | null | undefined, now: number = Date.now()): number => {
  if (!tokens) return 0
  if (typeof tokens.created_at === 'number' && typeof tokens.expires_in === 'number') {
    return ((tokens.expires_in + tokens.created_at) * 1000 - now) / 3600000
  }
  const exp = decodeJwtPayload(tokens.access_token)?.exp
  if (typeof exp === 'number') return (exp * 1000 - now) / 3600000
  return Number.POSITIVE_INFINITY
}
