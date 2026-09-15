'use strict';

const fs = require('fs');
const path = require('path');
const { pool } = require('./pool');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

/**
 * Lightweight forward-only SQL migration runner.
 *
 * - Each file in db/migrations/*.sql is applied once, in filename order.
 * - Applied filenames are recorded in the `_migrations` table.
 * - Each migration runs inside its own transaction, so a failure rolls back
 *   that file and stops the run (leaving earlier files applied).
 *
 * Naming convention: NNN_description.sql (zero-padded so lexical == numeric).
 */
async function runMigrations() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        filename   TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    const { rows } = await client.query('SELECT filename FROM _migrations');
    const applied = new Set(rows.map((r) => r.filename));

    const files = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    const pending = files.filter((f) => !applied.has(f));

    if (pending.length === 0) {
      console.log('[db] Schema up to date — no pending migrations.');
      return;
    }

    for (const file of pending) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      console.log(`[db] Applying migration: ${file}`);
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO _migrations (filename) VALUES ($1)', [file]);
        await client.query('COMMIT');
        console.log(`[db] ✓ ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`[db] ✗ Migration failed: ${file}\n${err.message}`);
        throw err;
      }
    }

    console.log(`[db] Applied ${pending.length} migration(s).`);
  } finally {
    client.release();
  }
}

module.exports = { runMigrations };

// Allow running directly: `node db/migrate.js`
if (require.main === module) {
  runMigrations()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
