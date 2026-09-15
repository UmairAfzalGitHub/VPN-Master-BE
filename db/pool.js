'use strict';

const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set. See .env.example.');
}

// Managed Postgres (Render, Heroku, etc.) generally requires SSL.
const useSsl = String(process.env.PGSSL).toLowerCase() === 'true';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: useSsl ? { rejectUnauthorized: false } : false,
  max: Number(process.env.PG_POOL_MAX || 10),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pool.on('error', (err) => {
  // Idle client errors shouldn't crash the process.
  console.error('[db] Unexpected idle client error:', err.message);
});

/**
 * Thin query helper so routes don't import Pool directly.
 * @param {string} text
 * @param {Array<any>} [params]
 */
function query(text, params) {
  return pool.query(text, params);
}

module.exports = { pool, query };
