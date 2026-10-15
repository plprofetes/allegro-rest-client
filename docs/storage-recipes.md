# Token storage recipes

`TokenStorage` is two methods (`get(account)`, `set(account, tokens)`, sync or async). The client calls `get` **once**, when it is created, and `set` after every authorization or refresh. The default keeps tokens in memory only, so they are lost on restart.

Allegro refresh tokens are **single use**: whoever refreshes first invalidates the token everybody else holds. So the storage must be shared by every process that uses the account, and refreshing must be serialized (see [Locking](#locking)). The snippets below are sketches to adapt, not tested library code; the storage client (`pg`, `ioredis`) is yours.

## File (one process)

Write atomically so a crash cannot leave half a file. Tokens are secrets: restrict the file mode.

```ts
import { readFile, rename, writeFile } from 'node:fs/promises'
import type { AuthResponse, TokenStorage } from 'allegro-rest-client'

type Store = Record<string, AuthResponse>

const readAll = async (path: string): Promise<Store> => {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw err
  }
}

export const fileStorage = (path: string): TokenStorage => ({
  async get(account) {
    return (await readAll(path))[account]
  },
  async set(account, tokens) {
    const all = await readAll(path)
    await writeFile(`${path}.tmp`, JSON.stringify({ ...all, [account]: tokens }), { mode: 0o600 })
    await rename(`${path}.tmp`, path)
  },
})
```

Only safe when a single process writes. Two processes can lose each other's accounts; use a database for that.

## SQL (several processes)

```sql
CREATE TABLE allegro_tokens (
  account text PRIMARY KEY,
  tokens jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
```

```ts
import type { Pool } from 'pg'
import type { TokenStorage } from 'allegro-rest-client'

export const pgStorage = (pool: Pool): TokenStorage => ({
  async get(account) {
    const { rows } = await pool.query('SELECT tokens FROM allegro_tokens WHERE account = $1', [account])
    return rows[0]?.tokens
  },
  async set(account, tokens) {
    await pool.query(
      `INSERT INTO allegro_tokens (account, tokens) VALUES ($1, $2)
       ON CONFLICT (account) DO UPDATE SET tokens = $2, updated_at = now()`,
      [account, tokens],
    )
  },
})
```

Encrypt the column (or the disk) if your policy requires it.

## Redis

```ts
import type { Redis } from 'ioredis'
import type { AuthResponse, TokenStorage } from 'allegro-rest-client'

export const redisStorage = (redis: Redis, prefix = 'allegro:tokens:'): TokenStorage => ({
  async get(account) {
    const raw = await redis.get(prefix + account)
    return raw ? (JSON.parse(raw) as AuthResponse) : undefined
  },
  async set(account, tokens) {
    await redis.set(prefix + account, JSON.stringify(tokens))
  },
})
```

Do not set a TTL: an expired key would lose the refresh token, the only way to continue without a new login.

## Locking

The library does not lock (see [wrapping.md](wrapping.md)). Because the client reads storage only when created, the simple safe pattern is: take a lock, create a client (which reads the newest tokens), do the work (a refresh, if one is due, happens inside the first request and is written back through `set`), release the lock.

```ts
import { AllegroRestClient, type AllegroClient } from 'allegro-rest-client'
import { randomUUID } from 'node:crypto'

async function withClient<T>(account: string, fn: (client: AllegroClient) => Promise<T>): Promise<T> {
  const key = `allegro:lock:${account}`
  const token = randomUUID()
  while ((await redis.set(key, token, 'PX', 30_000, 'NX')) !== 'OK') {
    await new Promise((r) => setTimeout(r, 200))
  }
  try {
    const client = await AllegroRestClient(config, { account, storage: redisStorage(redis) })
    return await fn(client)
  } finally {
    // release only our own lock (compare-and-delete), so an expired lock is never deleted from under its new owner
    await redis.eval(
      'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) end',
      1,
      key,
      token,
    )
  }
}
```

Keep the lock longer than your slowest request plus a refresh (30 s here), and keep the work inside it short. If locking each call is too coarse, hold the lock only when `client.getExpiresInHours()` is below your `refreshThresholdHours`. With PostgreSQL, `pg_advisory_lock(hashtext(account))` plays the same role.
