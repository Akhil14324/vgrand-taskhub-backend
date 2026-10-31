// Data-preservation check. Read-only: the session is set to read-only before any query.
//
//   node src/scripts/manifest.js > before.json              snapshot (row counts, id hashes, row hashes)
//   node src/scripts/manifest.js --compare before.json      compare now against a snapshot
//
// Connects to MANIFEST_DATABASE_URL, else DIRECT_URL. Compare exits 1 when any table lost rows,
// lost an id that existed in the snapshot, or disappeared. Changed rows are reported, not failed,
// because a live app changes rows all the time; on a quiet copy (staging) they should be zero.
const fs = require('fs');
const dotenv = require('dotenv');
const { Client } = require('pg');

dotenv.config();

async function snapshot(client) {
  const tables = (await client.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`
  )).rows.map((r) => r.table_name);

  const out = { taken_at: new Date().toISOString(), tables: {} };
  for (const t of tables) {
    const hasId = (await client.query(
      `SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'id'`,
      [t]
    )).rowCount > 0;
    const q = `SELECT count(*)::bigint AS rows,
        md5(coalesce(string_agg(md5(x::text), '' ORDER BY md5(x::text)), '')) AS row_hash
        ${hasId ? `, array_agg(x.id::text ORDER BY x.id::text) AS ids` : ''}
      FROM public."${t.replace(/"/g, '""')}" x`;
    const r = (await client.query(q)).rows[0];
    out.tables[t] = { rows: Number(r.rows), row_hash: r.row_hash, ...(hasId ? { ids: r.ids || [] } : {}) };
  }
  return out;
}

function compare(before, now) {
  const problems = [];
  const notes = [];
  for (const [t, b] of Object.entries(before.tables)) {
    const n = now.tables[t];
    if (!n) { problems.push(`${t}: table is gone`); continue; }
    if (n.rows < b.rows) problems.push(`${t}: rows ${b.rows} -> ${n.rows}`);
    if (b.ids && n.ids) {
      const have = new Set(n.ids);
      const lost = b.ids.filter((id) => !have.has(id));
      if (lost.length) problems.push(`${t}: ${lost.length} id(s) missing, e.g. ${lost.slice(0, 5).join(', ')}`);
    }
    if (n.row_hash !== b.row_hash) notes.push(`${t}: contents changed (${b.rows} -> ${n.rows} rows)`);
  }
  for (const t of Object.keys(now.tables)) if (!before.tables[t]) notes.push(`${t}: new table`);
  return { problems, notes };
}

async function main() {
  const url = process.env.MANIFEST_DATABASE_URL || process.env.DIRECT_URL;
  if (!url) throw new Error('Set MANIFEST_DATABASE_URL or DIRECT_URL');
  const local = /localhost|127\.0\.0\.1/.test(url);
  const client = new Client({ connectionString: url, ssl: local ? false : { rejectUnauthorized: false } });
  await client.connect();
  try {
    await client.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY');
    const now = await snapshot(client);
    const i = process.argv.indexOf('--compare');
    if (i === -1) {
      process.stdout.write(JSON.stringify(now, null, 2) + '\n');
      return 0;
    }
    const before = JSON.parse(fs.readFileSync(process.argv[i + 1], 'utf8'));
    const { problems, notes } = compare(before, now);
    notes.forEach((n) => console.log(`note  ${n}`));
    problems.forEach((p) => console.log(`LOST  ${p}`));
    console.log(problems.length ? `\n${problems.length} problem(s): data was lost.` : '\nNo data lost.');
    return problems.length ? 1 : 0;
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  main().then((code) => process.exit(code)).catch((err) => {
    console.error(String(err.message || err).replace(/postgres(ql)?:\/\/\S+/g, '<url>'));
    process.exit(2);
  });
}

module.exports = { compare };
