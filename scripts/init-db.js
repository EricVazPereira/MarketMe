// Cria o esquema e (opcionalmente) os dados de exemplo.
// Uso: npm run db:init            → esquema + seed
//      npm run db:init -- --no-seed  → só o esquema
//      npm run db:init -- --reset    → derruba as tabelas antes (cuidado!)
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { pool } from '../src/db.js';

const sqlPath = (name) =>
  fileURLToPath(new URL(`../db/${name}`, import.meta.url));

export async function initDb({ seed = true, reset = false } = {}) {
  if (reset) {
    await pool.query(`
      DROP TABLE IF EXISTS stock_movement, payment, order_item, orders,
        customer, store_product, product, store CASCADE`);
  }
  await pool.query(await readFile(sqlPath('schema.sql'), 'utf8'));
  if (seed) await pool.query(await readFile(sqlPath('seed.sql'), 'utf8'));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const seed = !process.argv.includes('--no-seed');
  const reset = process.argv.includes('--reset');
  initDb({ seed, reset })
    .then(() => {
      console.log(`Banco inicializado${seed ? ' com dados de exemplo' : ''}.`);
      return pool.end();
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
