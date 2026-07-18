const { Pool } = require('pg');
const dotenv = require('dotenv');

dotenv.config();

const isProduction = process.env.NODE_ENV === 'production';

const poolConfig = {
  connectionString: process.env.DATABASE_URL,
  max: isProduction ? 20 : 10,
  min: 2,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  maxUses: 7500,
};

if (isProduction && process.env.DATABASE_URL && process.env.DATABASE_URL.includes('render.com')) {
  poolConfig.ssl = { rejectUnauthorized: false };
}

const pool = new Pool(poolConfig);

const directPoolConfig = {
  connectionString: process.env.DIRECT_URL || process.env.DATABASE_URL,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
};

if (isProduction && process.env.DIRECT_URL && process.env.DIRECT_URL.includes('render.com')) {
  directPoolConfig.ssl = { rejectUnauthorized: false };
}

const directPool = new Pool(directPoolConfig);

pool.on('error', (err) => {
  console.error(`[${new Date().toISOString()}] Unexpected error on idle PostgreSQL client:`, err.message);
});

directPool.on('error', (err) => {
  console.error(`[${new Date().toISOString()}] Unexpected error on idle direct PostgreSQL client:`, err.message);
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool,
  directPool,
};
