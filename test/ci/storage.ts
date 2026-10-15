import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
import type { AuthResponse, TokenStorage } from '../../src'

// Keeps one account's tokens in an encrypted GitHub Actions *variable*, so a scheduled job can carry the rotating
// refresh token from run to run. The repository is public: the variable is readable by anyone who can see it, hence
// AES-256-GCM with a key that lives in a secret. Needs a fine-grained token with "Variables: read and write".

const VERSION = 'v1'

const keyFrom = (passphrase: string, salt: Buffer) => scryptSync(passphrase, salt, 32)

export function encrypt(plain: string, passphrase: string, aad: string): string {
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', keyFrom(passphrase, salt), iv)
  cipher.setAAD(Buffer.from(aad))
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return [VERSION, Buffer.concat([salt, iv, cipher.getAuthTag(), body]).toString('base64')].join('.')
}

export function decrypt(blob: string, passphrase: string, aad: string): string {
  const [version, payload] = blob.split('.')
  if (version !== VERSION || !payload) throw new Error('Unknown token state format')
  const raw = Buffer.from(payload, 'base64')
  const decipher = createDecipheriv('aes-256-gcm', keyFrom(passphrase, raw.subarray(0, 16)), raw.subarray(16, 28))
  decipher.setAAD(Buffer.from(aad))
  decipher.setAuthTag(raw.subarray(28, 44))
  try {
    return Buffer.concat([decipher.update(raw.subarray(44)), decipher.final()]).toString('utf8')
  } catch {
    throw new Error('Cannot decrypt the token state (wrong ALLEGRO_STATE_KEY, or the variable was modified)')
  }
}

export interface VariableStorageOptions {
  /** `owner/repo` */
  repo: string
  /** Variable name, e.g. `ALLEGRO_USER_TOKENS` */
  name: string
  /** Fine-grained token with Variables read/write on the repository. */
  token: string
  /** Secret used to encrypt the state. */
  passphrase: string
  fetch?: typeof fetch
  sleep?: (ms: number) => Promise<void>
}

export function githubVariableStorage(o: VariableStorageOptions): TokenStorage {
  const doFetch = o.fetch ?? fetch
  const sleep = o.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)))
  const base = `https://api.github.com/repos/${o.repo}/actions/variables`
  const call = (method: string, url: string, body?: unknown) =>
    doFetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${o.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'allegro-rest-client-ci',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    })

  return {
    async get() {
      const res = await call('GET', `${base}/${o.name}`)
      if (res.status === 404) return undefined
      if (!res.ok) throw new Error(`Reading variable ${o.name} failed: HTTP ${res.status}`)
      const { value } = (await res.json()) as { value: string }
      return value ? (JSON.parse(decrypt(value, o.passphrase, o.name)) as AuthResponse) : undefined
    },
    // The refresh token Allegro just handed out is single use and the old one is already spent, so losing this write
    // breaks the chain. Retry hard, and fail loudly (the caller then rejects) rather than carry on with unsaved tokens.
    async set(_account, tokens) {
      const value = encrypt(JSON.stringify(tokens), o.passphrase, o.name)
      let last = ''
      for (let attempt = 1; attempt <= 5; attempt++) {
        try {
          let res = await call('PATCH', `${base}/${o.name}`, { name: o.name, value })
          if (res.status === 404) res = await call('POST', base, { name: o.name, value })
          if (res.ok) return
          last = `HTTP ${res.status}`
          if (res.status === 401 || res.status === 403) break // a retry cannot fix a bad token
        } catch (err) {
          last = String(err)
        }
        await sleep(1000 * attempt)
      }
      throw new Error(
        `Could not save the new tokens to variable ${o.name} (${last}). The chain is broken: run the workflow with mode=bootstrap.`,
      )
    },
  }
}
