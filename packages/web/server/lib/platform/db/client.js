import pg from 'pg';

// Create the platform database handle. The same code runs against the real
// `pg` Pool in deployment and against the API-compatible pg-mem adapter in
// tests (pass it via `pgModule`).
export function createPlatformDb({ connectionString, pgModule = pg, poolOptions = {} }) {
  if (!connectionString || typeof connectionString !== 'string') {
    throw new Error('createPlatformDb requires a connectionString');
  }
  const pool = new pgModule.Pool({ connectionString, max: 5, ...poolOptions });
  return {
    pool,
    query: (text, params) => pool.query(text, params),
    close: () => pool.end(),
  };
}
