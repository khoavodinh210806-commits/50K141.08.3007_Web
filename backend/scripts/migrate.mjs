import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const migrations = ['001_init.sql', '002_frontend_workflows.sql', '003_import_backorder.sql', '004_recipe_size.sql', '005_ordered_codes.sql'];
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 15000 });
try {
  for (const file of migrations) {
    const sql = await readFile(fileURLToPath(new URL(`../sql/postgres/${file}`, import.meta.url)), 'utf8');
    await pool.query(sql);
  }
  console.log('PostgreSQL schema ready');
} finally {
  await pool.end();
}
