const { Pool, types } = require('pg');
const dotenv = require('dotenv');

dotenv.config();

// Return Postgres DATE columns as plain 'YYYY-MM-DD' strings instead of JS Dates,
// so calendar dates never shift across timezones on their way to the client.
types.setTypeParser(1082, (value) => value);

const isProduction = process.env.NODE_ENV === 'production';

// Hosted Postgres (Render, Supabase, Railway, Neon) needs TLS; their certificates are
// not always in Node's CA bundle, so accept them unless DATABASE_SSL=false.
const MANAGED_HOSTS = ['render.com', 'supabase.co', 'supabase.com', 'railway.app', 'rlwy.net', 'neon.tech'];
function sslFor(url) {
  if (process.env.DATABASE_SSL === 'false') return undefined;
  if (process.env.DATABASE_SSL === 'true') return { rejectUnauthorized: false };
  if (url && MANAGED_HOSTS.some((host) => url.includes(host))) return { rejectUnauthorized: false };
  return undefined;
}

const poolConfig = {
  connectionString: process.env.DATABASE_URL,
  max: isProduction ? 20 : 10,
  min: 2,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  maxUses: 7500,
  ssl: sslFor(process.env.DATABASE_URL),
};

const pool = new Pool(poolConfig);

const directUrl = process.env.DIRECT_URL || process.env.DATABASE_URL;
const directPoolConfig = {
  connectionString: directUrl,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  ssl: sslFor(directUrl),
};

const directPool = new Pool(directPoolConfig);

pool.on('error', (err) => {
  console.error(`[${new Date().toISOString()}] Unexpected error on idle PostgreSQL client:`, err.message);
});

directPool.on('error', (err) => {
  console.error(`[${new Date().toISOString()}] Unexpected error on idle direct PostgreSQL client:`, err.message);
});

async function waitForConnection(maxRetries = 5, delayMs = 2000) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await pool.query('SELECT 1');
      console.log(`[db] Connected successfully on attempt ${attempt}`);
      return;
    } catch (err) {
      console.error(`[db] Connection attempt ${attempt}/${maxRetries} failed: ${err.message}`);
      if (attempt === maxRetries) throw err;
      await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
    }
  }
}

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool,
  directPool,
  waitForConnection,
};
