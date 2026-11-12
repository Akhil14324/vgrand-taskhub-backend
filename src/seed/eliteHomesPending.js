const db = require('../db');
const { buildBoard } = require('../services/boardBuild');
const { DEFAULT_COLUMNS, DEFAULT_VIEWS } = require('../utils/columns');

/**
 * "Pending Remaining Works" for Elite Homes (VGrand Infra): one private site board with one group of that name.
 * Each flat (60) is a main task in it (101A ...), and the work listed for the flat on the handwritten
 * remaining-works sheet are that task's sub-tasks. (v1 made one group per flat; v2 replaces it.)
 * Runs once, tracked as ELITE_PENDING_MARKER. Only adds rows Nothing existing is changed.
 * NOT wired into migrations/run.js on purpose: run it by hand with `npm run seed:elite-homes`.
 */
const ELITE_PENDING_MARKER = 'seed:elite-homes-pending-works-v2';
const BOARD_NAME = 'Elite Homes - Remaining Works';
const TOP_GROUP = 'Pending Remaining Works';
const NOTE = 'Source: handwritten remaining-works sheet';

const SHEET = `
101A: Bathroom wall & floor tiles (3 bathrooms); Service wall & floor tiles; Windows grill + sliding door; Bathroom fittings & basin; Switch boards; Paint; Doors & locks: main, bedroom, bathroom, service
102A: Bathroom wall & floor tiles (3 bathrooms); Service wall & floor tiles; Windows grill + sliding door; Bathroom fittings & basin; Switch boards; Paint; Doors & locks: main, bedroom, bathroom, service
103A: Bathroom wall & floor tiles (3 bathrooms); Service wall & floor tiles; Windows grill + sliding door; Bathroom fittings & basin; Switch boards; Paint; Doors & locks: main, bedroom, bathroom, service
104A: Bathroom floor tiles (3 bathrooms); Service wall & floor tiles; Windows grill + sliding door; Bathroom fittings & basin; Switch boards; Paint; Doors & locks
105A: Bathroom floor tiles (3 bathrooms); Service wall & floor tiles; Windows grill + sliding door; Bathroom fittings & basin; Switch boards; Paint; Doors & locks
106A: Bathroom floor tiles (3 bathrooms); Service wall & floor tiles; Windows grill + sliding door; Bathroom fittings & basin; Switch boards; Paint; Doors & locks
201A: Windows grill; Bathroom fittings & basin; Switch boards; Paint; Doors & locks: main door
202A: Windows grill; Bathroom fittings & basin; Switch boards; Paint; Doors & locks: bathroom, main door
203A: Windows grill; Bathroom fittings & basin; Switch boards; Paint; Doors & locks: main door
204A: Windows grill; Bathroom fittings & basin; Switch boards; Paint; Doors & locks: bathroom, main door
205A: Bathroom fittings & basin; Bathroom locks; Paint (2nd coat)
206A: Bathroom fittings & basin; Switch boards; Paint; Doors & locks: bathroom
301A: Bathroom fittings & basin; Switch boards; Paint; Doors & locks: bathroom, main door; Windows grill
302A: Bathroom fittings & basin; Switch boards; Paint; Doors & locks: main door; Windows grill
303A: Bathroom fittings & basin; Switch boards; Paint; Doors & locks: main door; Windows grill
304A: Bathroom fittings & basin; Switch boards; Paint; Doors & locks: main door; Windows grill
305A: Bathroom fittings & basin; Switch boards; Paint; Doors & locks: bathroom, main door; Windows grill
306A: Bathroom fittings & basin; Switch boards; Paint; Doors & locks: bathroom, main door; Windows grill
401A: Bathroom wall & floor tiles (1 bathroom); Service wall & floor tiles; Windows grill; Bathroom fittings & basin; Switch boards; Doors & locks; Paint
402A: Bathroom floor tiles; Service floor tiles; Windows grill; Bathroom fittings & basin; Switch boards; Doors & locks: main door; Paint
403A: Bathroom floor tiles; Service floor tiles; Windows grill; Bathroom fittings & basin; Switch boards; Doors & locks: main door, bathroom; Paint
404A: Bathroom floor tiles; Service floor tiles; Windows grill; Bathroom fittings & basin; Switch boards; Paint; Doors & locks
405A: Windows grill; Bathroom fittings & basin; Switch boards; Paint; Doors & locks: bathroom, main door
406A: Windows grill; Doors & locks: bathroom, main door; Switch boards; Paint; Bathroom fittings & basin; Service floor tiles
501A: Bathroom wall & floor tiles; Service floor tiles; Bathroom fittings & basin; Switch boards; Paint; Doors & locks; Windows grill
502A: Bathroom floor tiles; Service floor tiles; Bathroom fittings & basin; Switch boards; Windows grill; Paint; Doors & locks
503A: Bathroom floor tiles; Service floor tiles; Bathroom fittings & basin; Switch boards; Windows grill; Paint; Doors & locks
504A: Bathroom wall & floor tiles; Service floor tiles; Bathroom fittings & basin; Switch boards; Paint; Doors & locks; Windows grill
505A: Service floor tiles; Bathroom fittings & basin; Switch boards; Windows grill; Paint; Doors & locks
506A: Bathroom wall & floor tiles; Service floor tiles; Bathroom fittings & basin; Switch boards; Windows grill; Paint; Doors & locks
101B: Bathroom floor & wall tiles (3 bathrooms); Windows grill + sliding door; Bathroom fittings & basin; Switch boards; Paint; Balcony glass
102B: Bathroom floor & wall tiles (3 bathrooms); Paint; Bathroom fittings & basin; Switch boards; Doors & locks: main, bedroom, bathroom; Windows grill + sliding door
103B: Bathroom floor & wall tiles (3 bathrooms); Bathroom fittings & basin; Switch boards; Windows grill + sliding door; Doors & locks: main, bedroom, bathroom
104B: Bathroom floor & wall tiles; Switch boards; Windows grill + sliding door; Paint; Doors & locks: main, bedroom, bathroom, service
105B: Bathroom floor & wall tiles; Switch boards; Windows grill + sliding door; Bathroom fittings & basin; Paint; Doors & locks: main, bedroom, bathroom, service
106B: Bathroom floor & wall tiles; Switch boards; Bathroom fittings & basin; Windows grill + sliding door; Doors & locks: main, bedroom, bathroom, service
201B: Bathroom floor tiles (3 bathrooms); Switch boards; Windows grill + sliding door; Bathroom fittings & basin; Paint; Doors & locks: main, bedroom, bathroom, service
202B: Bathroom floor & wall tiles; Switch boards; Windows grill + sliding door; Bathroom fittings & basin; Doors & locks: main, bedroom, bathroom, service
203B: Bathroom floor & wall tiles; Switch boards; Windows grill + sliding door; Bathroom fittings & basin; Doors & locks: main, bathroom, bedroom, service
204B: Bathroom floor & wall tiles (3 bathrooms); Windows grill + sliding door; Bathroom fittings & basin; Switch boards; Doors & locks: main, bedroom, bathroom
205B: Bathroom floor & wall tiles (3 bathrooms); Windows grill + sliding door; Bathroom fittings & basin; Switch boards; Doors & locks: main, bedroom, bathroom
206B: Bathroom fittings & basin (3 bathrooms); Switch boards; Windows grill + sliding door; Doors & locks: main, bedroom, bathroom; Paint
301B: Bathroom fittings & basin (3 bathrooms); Windows grill; Switch boards; Doors & locks: main, bedroom, bathroom
302B: Bathroom floor & wall tiles (3 bathrooms); Switch boards; Bathroom fittings & basin; Windows grill + sliding door; Doors & locks: main, bedroom, bathroom
303B: Bathroom floor & wall tiles (3 bathrooms); Switch boards; Windows grill + sliding door; Bathroom fittings & basin; Doors & locks: main, bedroom, bathroom
304B: Bathroom floor & wall tiles (3 bathrooms); Windows grill + sliding door; Switch boards; Bathroom fittings & basin; Doors & locks: main, bedroom, bathroom
305B: Bathroom floor & wall tiles (3 bathrooms); Windows grill + sliding door; Switch boards; Bathroom fittings & basin; Doors & locks: main, bedroom, bathroom
306B: Bathroom fittings & basin (3 bathrooms); Switch boards; Windows grill; Doors & locks: main, bedroom
401B: Bathroom floor tiles (3 bathrooms); Windows grill; Switch boards; Bathroom fittings & basin; Doors & locks: main, bedroom, bathroom
402B: Bathroom floor tiles (3 bathrooms); Windows grill + sliding door; Switch boards; Bathroom fittings & basin; Doors & locks: main, bedroom, bathroom
403B: Bathroom floor & wall tiles (3 bathrooms); Windows grill + sliding door; Switch boards; Bathroom fittings & basin; Doors & locks: main, bedroom
404B: Bathroom floor & wall tiles (3 bathrooms); Windows grill + sliding door; Switch boards; Bathroom fittings & basin; Doors & locks: main, bedroom, bathroom
405B: Bathroom floor & wall tiles (3 bathrooms); Windows grill + sliding doors; Switch boards; Bathroom fittings & basin; Doors & locks: main, bedroom, bathroom
406B:
501B: Bathroom floor & wall tiles (3 bathrooms); Switch boards; Windows grill + sliding doors; Paint; Bathroom fittings & basin; Doors & locks: main, bedroom, bathroom
502B: Bathroom floor & wall tiles (3 bathrooms); Switch boards; Windows grill + sliding doors; Paint; Bathroom fittings & basin; Doors & locks: main, bedroom, bathroom
503B: Bathroom floor & wall tiles (3 bathrooms); Switch boards; Windows grill + sliding doors; Paint; Bathroom fittings & basin; Doors & locks: main, bedroom, bathroom
504B: Bathroom floor & wall tiles (3 bathrooms); Switch boards; Windows grill + sliding doors; Paint; Bathroom fittings & basin; Doors & locks: main, bedroom, bathroom
505B: Bathroom floor & wall tiles (3 bathrooms); Switch boards; Windows grill + sliding doors; Paint; Bathroom fittings & basin; Doors & locks: main, bedroom, bathroom
506B: Bathroom floor & wall tiles (3 bathrooms); Switch boards; Windows grill + sliding doors; Paint; Bathroom fittings & basin; Doors & locks: main, bedroom, bathroom
`;
// 406B is "Locked - no work listed (confirm)" on the sheet: a note, not work, so its group is made with no tasks.

/** [{ flat, tasks: [title] }] in sheet order. */
function parseSheet(text = SHEET) {
  return text.split('\n').map((l) => l.trim()).filter(Boolean).map((line) => {
    const i = line.indexOf(':');
    const flat = line.slice(0, i).trim();
    const tasks = line.slice(i + 1).split(';').map((t) => t.trim()).filter(Boolean);
    return { flat, tasks };
  });
}

async function seedEliteHomesPending({ log = console.log } = {}) {
  const done = await db.directPool.query('SELECT 1 FROM migrations WHERE filename = $1', [ELITE_PENDING_MARKER]);
  if (done.rows.length) { log('Elite Homes pending works: already seeded, nothing to do.'); return { created: false }; }

  const flats = parseSheet();
  const names = flats.map((f) => f.flat);
  if (flats.length !== 60 || new Set(names).size !== 60) throw new Error(`Sheet must have 60 distinct flats, has ${flats.length}`);

  const site = (await db.directPool.query(
    `SELECT s.id, s.business_id FROM sites s JOIN businesses b ON b.id = s.business_id
      WHERE b.name ILIKE '%infra%' AND s.name = 'Elite Homes' ORDER BY b.id LIMIT 1`)).rows[0];
  if (!site) throw new Error('Site "Elite Homes" under the Infra business not found.');

  const clash = await db.directPool.query('SELECT id FROM boards WHERE site_id = $1 AND name = $2', [site.id, BOARD_NAME]);
  if (clash.rows.length) throw new Error(`Board "${BOARD_NAME}" (id ${clash.rows[0].id}) already exists without the seed marker; refusing to build a second one.`);

  const actorRow = (await db.directPool.query(
    `SELECT id, name FROM users WHERE LOWER(username) = 'akhil'
     UNION ALL SELECT id, name FROM users WHERE role = 'super_admin' ORDER BY 1 LIMIT 1`)).rows[0];
  if (!actorRow) throw new Error('No user to own the board.');
  const actor = { id: actorRow.id };

  const def = {
    icon: 'home-outline', color: 'blue', item_word: 'Task',
    columns: DEFAULT_COLUMNS.map((k) => ({ system_key: k })),
    views: DEFAULT_VIEWS,
    groups: [{
      name: TOP_GROUP, color: 'blue',
      items: flats.map((f) => ({ title: f.flat, notes: NOTE, subtasks: f.tasks.map((title) => ({ title, notes: NOTE })) })),
    }],
  };
  log('Building Elite Homes - Remaining Works...');
  const out = await buildBoard(actor, {
    scope: 'site', business_id: site.business_id, site_id: site.id, name: BOARD_NAME, privacy: 'private',
    description: 'Pending remaining works per flat, from the handwritten sheet.',
  }, def, { withItems: true });
  await db.directPool.query('INSERT INTO migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING', [ELITE_PENDING_MARKER]);
  log(`  ✓ board ${out.board.id}: ${flats.length} main tasks, ${out.items - flats.length} sub-tasks.`);
  return { created: true, boardId: out.board.id, items: out.items };
}

module.exports = { seedEliteHomesPending, parseSheet, ELITE_PENDING_MARKER, BOARD_NAME, TOP_GROUP };

if (require.main === module) {
  seedEliteHomesPending()
    .then(() => db.directPool.end().then(() => process.exit(0)))
    .catch((err) => { console.error('Seed failed:', err.message); process.exit(1); });
}
