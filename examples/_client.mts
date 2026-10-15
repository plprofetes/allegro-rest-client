// Shared by the examples. Read the numbered examples first; this file only decides WHERE a client talks to.
//
//   offline (default)  a fake Allegro from `allegro-rest-client/testing`: no network, no credentials, deterministic
//   LIVE=1             the real Allegro SANDBOX with your device application (read-only examples only)
//
// For LIVE=1 put these in .env and run `node --env-file=.env examples/04-pagination.ts`:
//   ALLEGRO_CLIENT_ID, ALLEGRO_CLIENT_SECRET   a sandbox *device* application (apps.developer.allegro.pl.allegrosandbox.pl)
// The first live run prints a URL to approve (device flow); the tokens are cached in .allegro-tokens.json (git-ignored).

import { readFileSync, writeFileSync } from 'node:fs'
import { AllegroRestClient, type AllegroClient, type AuthResponse, type ClientOptions } from 'allegro-rest-client'
import { mockAllegro, type MockRequest, type MockRoute } from 'allegro-rest-client/testing'

export const LIVE = process.env.LIVE === '1'
export const TOKEN_FILE = '.allegro-tokens.json'

/** A `TokenStorage` that keeps tokens in a JSON file: enough for a single local process (see docs/storage-recipes.md). */
export const fileStorage = (path: string) => ({
  get(account: string): AuthResponse | undefined {
    try {
      return (JSON.parse(readFileSync(path, 'utf8')) as Record<string, AuthResponse>)[account]
    } catch {
      return undefined
    }
  },
  set(account: string, tokens: AuthResponse) {
    let all: Record<string, AuthResponse> = {}
    try {
      all = JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      // first write
    }
    writeFileSync(path, JSON.stringify({ ...all, [account]: tokens }), { mode: 0o600 })
  },
})

const liveConfig = () => {
  const { ALLEGRO_CLIENT_ID: client_id, ALLEGRO_CLIENT_SECRET: client_secret } = process.env
  if (!client_id || !client_secret) {
    throw new Error('LIVE=1 needs ALLEGRO_CLIENT_ID and ALLEGRO_CLIENT_SECRET (sandbox device application)')
  }
  return { app_name: 'examples', type: 'device', client_id, client_secret } as const
}

export interface Connection<Paths extends object = object> {
  client: AllegroClient<Paths>
  /** Every request that reached the (fake) network; empty when LIVE=1. */
  calls: MockRequest[]
  mode: 'offline' | 'live sandbox'
}

/**
 * An authorized client. Offline it answers from `routes` (`'METHOD /path'` -> reply or function, see
 * allegro-rest-client/testing). Live it uses the sandbox and `routes` are ignored.
 */
export async function connect<Paths extends object = object>(
  routes: Record<string, MockRoute> = {},
  options: ClientOptions = {},
): Promise<Connection<Paths>> {
  if (!LIVE) {
    const mock = mockAllegro(routes)
    return { client: await mock.client<Paths>(options), calls: mock.calls, mode: 'offline' }
  }
  const client = await AllegroRestClient<Paths>(liveConfig(), {
    sandbox: true,
    storage: fileStorage(TOKEN_FILE),
    userAgent: 'allegro-rest-client-examples',
    ...options,
  })
  if (client.getExpiresInHours() === '0.00') {
    const device = await client.bindApp!()
    console.log(`Approve the sandbox app: ${device.verification_uri_complete}`)
    await client.pollDevice(device)
  }
  return { client, calls: [], mode: 'live sandbox' }
}

/** A client with NO tokens yet, for the authorization examples. Offline it answers from `routes`. */
export async function connectUnauthorized(
  routes: Record<string, MockRoute>,
  options: ClientOptions = {},
  config: Record<string, string> = {},
): Promise<Connection> {
  const empty = () => {
    let tokens: AuthResponse | undefined
    return { get: () => tokens, set: (_account: string, t: AuthResponse) => void (tokens = t) }
  }
  if (!LIVE) {
    const mock = mockAllegro(routes)
    const client = await mock.client({ storage: empty(), sleep: async () => {}, ...options }, config)
    return { client, calls: mock.calls, mode: 'offline' }
  }
  const client = await AllegroRestClient(
    { ...liveConfig(), ...config },
    { sandbox: true, storage: empty(), ...options },
  )
  return { client, calls: [], mode: 'live sandbox' }
}

export const section = (title: string) => console.log(`\n== ${title}`)
export const show = (label: string, value: unknown) =>
  console.log(`   ${label}:`, typeof value === 'string' ? value : JSON.stringify(value))

/** Runs `check` only offline, where the data is ours; live data differs per account. */
export const offlineOnly = (check: () => void) => {
  if (!LIVE) check()
}

/** Header names we are about to print are fine; secrets are not. */
export const wire = (call: MockRequest) => ({
  request: `${call.method} ${call.path}${call.query.size ? '?' + call.query : ''}`,
  headers: Object.fromEntries([...call.headers].filter(([name]) => name !== 'authorization')),
  ...(call.body !== undefined ? { body: call.body } : {}),
})
