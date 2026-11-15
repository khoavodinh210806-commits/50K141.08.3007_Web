import pg, { Pool, PoolClient } from 'pg';

pg.types.setTypeParser(1700, Number);
pg.types.setTypeParser(20, Number);

let instance: Pool | undefined;
let ready: Promise<Pool> | undefined;
export function pool(): Promise<Pool> {
  if (!ready) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is required');
    instance = new Pool({ connectionString: url, max: Number(process.env.DB_POOL_MAX || 5),
      connectionTimeoutMillis: 15000, idleTimeoutMillis: 30000 });
    ready = instance.query('SELECT 1').then(() => instance!).catch(error => { ready = undefined; void instance?.end(); instance = undefined; throw error; });
  }
  return ready;
}

export type DbTransaction = PoolClient;
function prepare(text: string, values: Record<string, unknown>) {
  let statement = text
    .replace(/\bAS\s+([a-zA-Z][a-zA-Z0-9_]*)\b/g, (_, alias: string) => `AS "${alias}"`)
    .replace(/@([a-zA-Z][a-zA-Z0-9_]*) IS NULL/g, '@$1::text IS NULL');
  const keys: string[] = [];
  statement = statement.replace(/@([a-zA-Z][a-zA-Z0-9_]*)/g, (_, key: string) => {
    if (!(key in values)) throw new Error(`Missing SQL parameter: ${key}`);
    let index = keys.indexOf(key);
    if (index < 0) { keys.push(key); index = keys.length - 1; }
    return `$${index + 1}`;
  });
  return { text: statement, values: keys.map(key => values[key] ?? null) };
}
export async function query<T extends pg.QueryResultRow = Record<string, unknown>>(text: string, values: Record<string, unknown> = {}): Promise<T[]> {
  return (await (await pool()).query<T>(prepare(text, values))).rows;
}
export async function one<T extends pg.QueryResultRow = Record<string, unknown>>(text: string, values: Record<string, unknown> = {}): Promise<T | undefined> {
  return (await query<T>(text, values))[0];
}
export async function transaction<T>(fn: (tx: DbTransaction) => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const client = await (await pool()).connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (attempt < 2 && ['40001', '40P01'].includes((error as { code?: string }).code || '')) continue;
      throw error;
    } finally { client.release(); }
  }
  throw new Error('Database transaction retry limit exceeded');
}
export async function txQuery<T extends pg.QueryResultRow = Record<string, unknown>>(tx: DbTransaction, text: string, values: Record<string, unknown> = {}) {
  const result = await tx.query<T>(prepare(text, values));
  return { recordset: result.rows, rowsAffected: [result.rowCount || 0] };
}
