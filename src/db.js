import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;

// Azure Database for PostgreSQL requires SSL. Support either a single
// DATABASE_URL connection string or discrete PG* variables.
const pool = new Pool(
  process.env.DATABASE_URL
    ? {
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false },
        max: 5,
      }
    : {
        host: process.env.PGHOST,
        port: Number(process.env.PGPORT) || 5432,
        user: process.env.PGUSER,
        password: process.env.PGPASSWORD,
        database: process.env.PGDATABASE || 'postgres',
        ssl: process.env.PGSSL === 'false' ? false : { rejectUnauthorized: false },
        max: 5,
      }
);

// Simple one-shot query.
export const query = (text, params) => pool.query(text, params);

// Run a set of statements inside a single transaction. The callback gets a
// dedicated client; we COMMIT on success and ROLLBACK on any thrown error.
export async function withTransaction(fn) {
  const client = await pool.connect();
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

export default pool;
