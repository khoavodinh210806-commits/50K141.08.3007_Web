import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const path = process.argv[2];
if (!path || process.argv[3] !== '--apply') throw Error('Usage: node scripts/restore-app-backup.mjs <backup.json> --apply');
if (!process.env.DATABASE_URL) throw Error('DATABASE_URL is required');
const tables = [
  'branches', 'users', 'user_branches', 'auth_sessions', 'suppliers', 'materials',
  'branch_stock', 'branch_thresholds', 'recipes', 'recipe_versions', 'recipe_ingredients',
  'import_slips', 'import_items', 'import_receipts', 'import_receipt_items',
  'export_slips', 'export_items', 'stocktakes', 'stocktake_items', 'sales_imports',
  'sales_items', 'sales_unmatched_items', 'approval_requests', 'stock_movements', 'audit_logs',
];
const backup = JSON.parse(await readFile(path, 'utf8'));
if (!backup.rows || Object.keys(backup.rows).sort().join(',') !== [...tables].sort().join(','))
  throw Error('Backup does not match the expected table list');
const quote = name => `"${name.replaceAll('"', '""')}"`;
const client = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 15000 });
await client.connect();
try {
  await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  const actualTables = (await client.query("SELECT table_name FROM information_schema.tables WHERE table_schema='app' AND table_type='BASE TABLE' ORDER BY table_name"))
    .rows.map(row => row.table_name);
  if (actualTables.join(',') !== [...tables].sort().join(',')) throw Error('Current schema differs from the backup');
  await client.query(`TRUNCATE ${tables.map(table => `app.${quote(table)}`).join(', ')}`);
  for (const table of tables) for (const row of backup.rows[table]) {
    const columns = Object.keys(row);
    await client.query(`INSERT INTO app.${quote(table)} (${columns.map(quote).join(',')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(',')})`, Object.values(row));
  }
  await client.query(await readFile(fileURLToPath(new URL('../sql/postgres/005_ordered_codes.sql', import.meta.url)), 'utf8'));
  await client.query('COMMIT');
  console.log('Restored app data from', path);
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  await client.end();
}
