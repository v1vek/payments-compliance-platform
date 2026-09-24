import pg from 'pg';

// bigint (int8) columns hold cents. Parse to number, refusing anything outside
// the safe-integer range rather than silently losing precision.
pg.types.setTypeParser(pg.types.builtins.INT8, (v: string) => {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new Error(`int8 value ${v} exceeds safe integer range`);
  return n;
});

export type Db = pg.Pool;
export type Tx = pg.PoolClient;
export type Queryable = pg.Pool | pg.PoolClient;

// TLS comes from the connection string. Hosted databases should use
// sslmode=verify-full so the server certificate is always verified.
export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString, max: 10 });
}

export async function tx<T>(db: Db, fn: (c: Tx) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
