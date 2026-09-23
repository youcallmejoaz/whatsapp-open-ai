import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createDb, tx, type Db } from './db.ts';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));

/** Apply pending *.sql migrations in filename order, each in its own transaction. */
export async function migrate(db: Db, log: (msg: string) => void = () => {}): Promise<string[]> {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const { rows } = await db.query<{ name: string }>('SELECT name FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.name));
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
    await tx(db, async (c) => {
      // Serialise concurrent migrators (e.g. two replicas booting at once).
      await c.query('SELECT pg_advisory_xact_lock(724001)');
      const again = await c.query('SELECT 1 FROM schema_migrations WHERE name = $1', [file]);
      if (again.rowCount) return;
      await c.query(sql);
      await c.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      ran.push(file);
    });
    log(`applied ${file}`);
  }
  return ran;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = createDb(process.env.DATABASE_URL ?? 'postgres://wa:wa@localhost:5432/wa');
  migrate(db, console.log)
    .then((ran) => console.log(ran.length ? `done (${ran.length})` : 'up to date'))
    .finally(() => db.end());
}
