import pg from 'pg';

// Return bigint counts as numbers and keep timestamps as Date objects.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));

export type Db = pg.Pool;
export type Queryable = pg.Pool | pg.PoolClient;

export function createDb(connectionString: string): Db {
  return new pg.Pool({ connectionString, max: 10 });
}

export async function tx<T>(db: Db, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** pgvector literal for a JS number array. */
export function toVector(v: number[]): string {
  return `[${v.join(',')}]`;
}
