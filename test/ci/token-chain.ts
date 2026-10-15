import { AllegroRestClient, type AuthResponse } from '../../src'
import { encrypt, githubVariableStorage } from './storage'

// CLI for .github/workflows/user-token.yml:
//   bootstrap  device flow with a person approving; stores the first tokens
//   local      same device flow on your machine; prints the encrypted state to paste as a repository variable
//   refresh    spends the stored refresh token, stores the rotated one, and proves the new token works
// Never prints tokens. Environment: ALLEGRO_CLIENT_ID/SECRET, GITHUB_REPOSITORY, CI_STATE_PAT, ALLEGRO_STATE_KEY.

const env = (name: string) => {
  const value = process.env[name]
  if (!value) throw new Error(`Missing ${name}`)
  return value
}

const storage = () =>
  githubVariableStorage({
    repo: env('GITHUB_REPOSITORY'),
    name: process.env.ALLEGRO_STATE_VARIABLE ?? 'ALLEGRO_USER_TOKENS',
    token: env('CI_STATE_PAT'),
    passphrase: env('ALLEGRO_STATE_KEY'),
  })

const clientFor = (refreshThresholdHours?: number) =>
  AllegroRestClient(
    {
      app_name: 'ci',
      type: 'device',
      client_id: env('ALLEGRO_CLIENT_ID'),
      client_secret: env('ALLEGRO_CLIENT_SECRET'),
    },
    {
      sandbox: true,
      storage: storage(),
      account: 'ci',
      refreshThresholdHours,
      userAgent: 'allegro-rest-client-ci (+https://github.com/plprofetes/allegro-rest-client)',
    },
  )

/** `exp` of the refresh token if it happens to be a JWT: tells us its lifetime, which Allegro's docs were not reachable to confirm. */
function refreshTokenExpiry(token: string): string {
  const part = token.split('.')[1]
  if (!part) return 'not a JWT (lifetime unknown)'
  try {
    const exp = (JSON.parse(Buffer.from(part, 'base64url').toString()) as { exp?: number }).exp
    return exp ? new Date(exp * 1000).toISOString() : 'JWT without exp'
  } catch {
    return 'not a JWT (lifetime unknown)'
  }
}

function summary(label: string, tokens: AuthResponse, previous?: AuthResponse) {
  console.log(`${label}: access token valid ${tokens.expires_in}s, ${tokens.scope.split(' ').length} scopes`)
  console.log(`${label}: refresh token expiry: ${refreshTokenExpiry(tokens.refresh_token)}`)
  if (previous) console.log(`${label}: refresh token rotated: ${previous.refresh_token !== tokens.refresh_token}`)
}

async function bootstrap() {
  const client = await clientFor()
  const device = await client.bindApp!()
  console.log(`::notice title=Approve the sandbox app::${device.verification_uri_complete}`)
  console.log(`Approve here within ${Math.round(device.expires_in / 60)} minutes: ${device.verification_uri_complete}`)
  const tokens = await client.pollDevice(device)
  summary('bootstrap', tokens)
  await client.get('/me')
  console.log('bootstrap: stored, and /me works with the new token')
}

async function refresh() {
  const before = await storage().get('ci')
  if (!before) throw new Error('NO_STATE: no stored tokens')
  // A threshold larger than any token lifetime makes the first request refresh. The new tokens are written to the
  // variable inside the client (set is awaited) before the request is sent, so nothing is ever used unsaved.
  const client = await clientFor(1_000_000)
  await client.get('/me')
  const after = (await storage().get('ci'))!
  summary('refresh', after, before)
}

/** Runs on your machine: needs only the sandbox keys and ALLEGRO_STATE_KEY, no GitHub token. */
async function local() {
  const name = process.env.ALLEGRO_STATE_VARIABLE ?? 'ALLEGRO_USER_TOKENS'
  let captured: AuthResponse | undefined
  const client = await AllegroRestClient(
    {
      app_name: 'ci',
      type: 'device',
      client_id: env('ALLEGRO_CLIENT_ID'),
      client_secret: env('ALLEGRO_CLIENT_SECRET'),
    },
    {
      sandbox: true,
      account: 'ci',
      userAgent: 'allegro-rest-client-ci (+https://github.com/plprofetes/allegro-rest-client)',
      storage: { get: () => undefined, set: (_account, tokens) => void (captured = tokens) },
    },
  )
  const device = await client.bindApp!()
  console.log(
    `Open and approve the sandbox app (valid ${Math.round(device.expires_in / 60)} minutes):\n${device.verification_uri_complete}\n`,
  )
  const tokens = await client.pollDevice(device)
  await client.get('/me')
  summary('local', captured ?? tokens)
  const blob = encrypt(JSON.stringify(captured ?? tokens), env('ALLEGRO_STATE_KEY'), name)
  console.log(
    `\nCreate the repository VARIABLE (Settings > Secrets and variables > Actions > Variables) named ${name} with this value:\n\n${blob}\n`,
  )
  console.log(
    'Use the same ALLEGRO_STATE_KEY as the repository secret. Do not run anything else with these tokens until the first scheduled refresh: the refresh token is single use.',
  )
}

const mode = process.argv[2]
const run = { bootstrap, refresh, local }[mode as 'bootstrap' | 'refresh' | 'local']
if (!run) {
  console.error('usage: token-chain bootstrap|refresh|local')
  process.exit(2)
}
run().catch((err: unknown) => {
  const e = err as { error?: string; error_description?: unknown; message?: string }
  const code = e.error ?? e.message ?? String(err)
  const broken = code.startsWith('NO_STATE') || e.error === 'invalid_grant' || e.error === 'invalid_token'
  console.error(`::error title=Token chain::${code}${e.error_description ? ` (${String(e.error_description)})` : ''}`)
  if (broken)
    console.error('::error title=Re-approval needed::Run this workflow with mode=bootstrap and approve the app.')
  process.exit(1)
})
