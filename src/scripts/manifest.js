// Data-preservation check. Read-only: the session is set to read-only before any query.
//
//   node src/scripts/manifest.js > before.json              snapshot (row counts, id hashes, row hashes)
//   node src/scripts/manifest.js --compare before.json      compare now against a snapshot
//
// Connects to MANIFEST_DATABASE_URL, else DIRECT_URL. Compare exits 1 when any table lost rows,
// lost an id that existed in the snapshot, lost a column, or disappeared. Rows are hashed over the
// columns the snapshot had, so added columns don't count as changes. Changed rows are reported, not
// failed, because a live app changes rows all the time; on a quiet copy (staging) they should be zero.
const fs = require('fs');
const dotenv = require('dotenv');
const { Client } = require('pg');

dotenv.config();

const ident = (s) => `"${String(s).replace(/"/g, '""')}"`;

/**
 * Every table's row count, ids and a hash of its rows. `columnsFrom` (an earlier snapshot) makes the hash
 * cover only the columns that table had then, so a migration that adds columns still proves the existing
 * values are untouched.
 */
async function snapshot(client, columnsFrom = null) {
  const tables = (await client.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`
  )).rows.map((r) => r.table_name);

  const out = { taken_at: new Date().toISOString(), tables: {} };
  for (const t of tables) {
    const columns = (await client.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
      [t]
    )).rows.map((r) => r.column_name);
    const hasId = columns.includes('id');
    const earlier = columnsFrom?.tables?.[t]?.columns;
    const hashed = earlier ? earlier.filter((c) => columns.includes(c)) : null;
    const rowText = hashed ? `ROW(${hashed.map((c) => `x.${ident(c)}`).join(', ')})::text` : 'x::text';
    const q = `SELECT count(*)::bigint AS rows,
        md5(coalesce(string_agg(md5(${rowText}), '' ORDER BY md5(${rowText})), '')) AS row_hash
        ${hasId ? `, array_agg(x.id::text ORDER BY x.id::text) AS ids` : ''}
      FROM public.${ident(t)} x`;
    const r = (await client.query(q)).rows[0];
    // Per-row hashes (tables with an id, up to 200k rows) tell "an existing row changed" from "rows were added".
    let rowHashes;
    if (hasId && Number(r.rows) <= 200000) {
      rowHashes = {};
      const rows = await client.query(`SELECT x.id::text AS id, md5(${rowText}) AS h FROM public.${ident(t)} x`);
      for (const row of rows.rows) rowHashes[row.id] = row.h;
    }
    out.tables[t] = {
      rows: Number(r.rows), row_hash: r.row_hash, columns, ...(hasId ? { ids: r.ids || [] } : {}),
      ...(rowHashes ? { row_hashes: rowHashes } : {}),
      ...(earlier && hashed.length < earlier.length ? { dropped_columns: earlier.filter((c) => !columns.includes(c)) } : {}),
    };
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
    if (n.dropped_columns?.length) problems.push(`${t}: column(s) gone: ${n.dropped_columns.join(', ')}`);
    if (b.ids && n.ids) {
      const have = new Set(n.ids);
      const lost = b.ids.filter((id) => !have.has(id));
      if (lost.length) problems.push(`${t}: ${lost.length} id(s) missing, e.g. ${lost.slice(0, 5).join(', ')}`);
    }
    if (b.row_hashes && n.row_hashes) {
      const changedRows = Object.keys(b.row_hashes).filter((id) => n.row_hashes[id] !== undefined && n.row_hashes[id] !== b.row_hashes[id]);
      const added = Object.keys(n.row_hashes).filter((id) => b.row_hashes[id] === undefined).length;
      if (changedRows.length) notes.push(`${t}: ${changedRows.length} existing row(s) changed, e.g. id ${changedRows.slice(0, 5).join(', ')}`);
      if (added) notes.push(`${t}: ${added} row(s) added`);
    } else if (n.row_hash !== b.row_hash) {
      notes.push(`${t}: contents changed (${b.rows} -> ${n.rows} rows)`);
    }
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
    // Row hashes depend on how timestamps print, so fix the zone and style on every server.
    await client.query("SET TIME ZONE 'UTC'; SET DateStyle = 'ISO, MDY'; SET extra_float_digits = 1");
    const i = process.argv.indexOf('--compare');
    if (i === -1) {
      process.stdout.write(JSON.stringify(await snapshot(client), null, 2) + '\n');
      return 0;
    }
    const before = JSON.parse(fs.readFileSync(process.argv[i + 1], 'utf8'));
    const now = await snapshot(client, before);
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
