const db = require('../db');
const { listTodos } = require('./todoQueries');
const { addSystemColumn, addStatusLabels } = require('./boards');
const { cleanSettings, cleanValue, COLOR_NAMES } = require('../utils/columns');
const { sanitizeText } = require('../middleware/sanitize');

/**
 * Boards from definitions and definitions from boards (templates, duplicate, M9). A definition is the shape in
 * utils/boardTemplates.js. Building always makes new rows: a template or a copy never changes the board it came from.
 */

const ITEM_LIMIT = 500;

/** A board as a definition: its columns, labels, groups and shared views, and its items if asked ('all' | 'open'). */
async function definitionFromBoard(board, actor, withItems = 'none') {
  const [cols, labels, groups, views] = await Promise.all([
    db.query('SELECT * FROM board_columns WHERE board_id = $1 AND archived_at IS NULL ORDER BY sort_order, id', [board.id]),
    db.query(`SELECT l.* FROM status_labels l JOIN board_columns c ON c.id = l.column_id WHERE c.board_id = $1 AND l.archived_at IS NULL ORDER BY l.sort_order, l.id`, [board.id]),
    db.query('SELECT * FROM todo_sections WHERE board_id = $1 AND NOT archived ORDER BY sort_order, id', [board.id]),
    db.query('SELECT kind, name, settings FROM board_views WHERE board_id = $1 AND owner_id IS NULL AND archived_at IS NULL ORDER BY sort_order, id', [board.id]),
  ]);
  const columns = cols.rows.map((c) => (c.system_key
    ? { system_key: c.system_key, title: c.title }
    : {
      kind: c.kind, title: c.title, settings: c.settings,
      labels: c.kind === 'status' ? labels.rows.filter((l) => l.column_id === c.id).map((l) => ({ label: l.label, color: l.color })) : undefined,
    }));
  const statusLabels = labels.rows.filter((l) => cols.rows.find((c) => c.id === l.column_id)?.system_key === 'status')
    .map((l) => ({ label: l.label, color: l.color, maps_to: l.maps_to }));

  let byGroup = new Map();
  if (withItems === 'all' || withItems === 'open') {
    const items = await listTodos(actor.id, {
      actor,
      where: `t.board_id = $5 AND t.parent_id IS NULL ${withItems === 'open' ? 'AND NOT t.is_done' : ''}`,
      params: [board.id],
      tail: `ORDER BY t.business_section_id, COALESCE(tm.sort_order, 0), t.created_at LIMIT ${ITEM_LIMIT}`,
    });
    const vals = items.length
      ? (await db.query('SELECT todo_id, column_id, value FROM item_values WHERE todo_id = ANY($1::int[])', [items.map((t) => t.id)])).rows
      : [];
    const titleOf = new Map(cols.rows.map((c) => [c.id, c.title]));
    const labelName = new Map(labels.rows.map((l) => [l.id, l.label]));
    byGroup = new Map();
    for (const t of items) {
      const values = {};
      for (const v of vals.filter((x) => x.todo_id === t.id)) {
        if (!titleOf.has(v.column_id)) continue;
        // A custom status keeps its label by name (label ids belong to this board only).
        values[titleOf.get(v.column_id)] = v.value?.label_id ? { label: labelName.get(v.value.label_id) } : v.value;
      }
      const entry = { title: t.title, notes: t.notes || '', priority: t.priority, due_date: t.due_date, start_date: t.start_date, values };
      const key = t.business_section_id || 0;
      if (!byGroup.has(key)) byGroup.set(key, []);
      byGroup.get(key).push(entry);
    }
  }
  return {
    icon: board.icon, color: board.color, item_word: board.item_word,
    status_labels: statusLabels,
    columns,
    groups: [
      ...(byGroup.get(0)?.length ? [{ name: 'Group 1', color: 'grey', items: byGroup.get(0) }] : []),
      ...groups.rows.map((g) => ({ name: g.name, color: g.color || 'blue', items: byGroup.get(g.id) || [] })),
    ],
    views: views.rows,
  };
}

/**
 * Make a new board from a definition. `place` = { scope, business_id, site_id, name, privacy }. Items are
 * created through createTodoCore (quiet), so they follow every rule of a new to-do.
 */
async function buildBoard(actor, place, def, { withItems = true, createTodoCore } = {}) {
  const color = COLOR_NAMES.includes(def.color) ? def.color : 'blue';
  const board = (await db.query(
    `INSERT INTO boards (scope, business_id, site_id, owner_id, name, description, icon, color, privacy, kind, item_word, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'custom', $10, $11) RETURNING *`,
    [
      place.scope, place.business_id || null, place.site_id || null, place.scope === 'personal' ? actor.id : null,
      place.name, place.description || '', def.icon || 'grid-outline', color,
      place.privacy || (place.scope === 'personal' ? 'private' : 'main'), String(def.item_word || 'Task').slice(0, 30), actor.id,
    ]
  )).rows[0];

  const colIdByTitle = new Map();
  const cols = [];
  let order = 0;
  for (const c of def.columns || []) {
    order += 1;
    let col;
    if (c.system_key) {
      col = await addSystemColumn(db, board.id, c.system_key, order, actor.id);
      if (c.system_key === 'status' && def.status_labels?.length) {
        await db.query('DELETE FROM status_labels WHERE column_id = $1', [col.id]);
        await addStatusLabels(db, col.id, def.status_labels);
      }
    } else {
      col = (await db.query(
        `INSERT INTO board_columns (board_id, kind, title, sort_order, settings, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [board.id, c.kind, String(c.title).slice(0, 120), order, cleanSettings(c.kind, c.settings || {}), actor.id]
      )).rows[0];
      if (c.kind === 'status') {
        await addStatusLabels(db, col.id, (c.labels?.length ? c.labels : [{ label: 'Not started', color: 'grey' }, { label: 'Working on it', color: 'orange' }, { label: 'Stuck', color: 'red' }, { label: 'Done', color: 'green' }])
          .map((l) => ({ label: String(l.label).slice(0, 60), color: COLOR_NAMES.includes(l.color) ? l.color : 'grey' })));
      }
    }
    cols.push(col);
    colIdByTitle.set(String(c.title || col.title).toLowerCase(), col);
  }
  if (!cols.some((c) => c.system_key === 'status')) {
    // Every board can say where each item stands.
    cols.push(await addSystemColumn(db, board.id, 'status', order + 1, actor.id));
  }

  const views = def.views?.length ? def.views : [{ kind: 'table', name: 'Main table' }, { kind: 'kanban', name: 'Kanban' }];
  await db.query(
    `INSERT INTO board_views (board_id, owner_id, kind, name, settings, sort_order)
     SELECT $1, NULL, v.kind, v.name, v.settings::jsonb, v.ord
       FROM unnest($2::text[], $3::text[], $4::text[]) WITH ORDINALITY AS v(kind, name, settings, ord)`,
    [board.id, views.map((v) => v.kind), views.map((v) => String(v.name || v.kind).slice(0, 80)), views.map((v) => JSON.stringify(v.settings || {}))]
  );

  // Custom status columns keep labels by name in a definition; values are re-pointed at the new labels.
  const labelIds = new Map();
  const statusCols = cols.filter((c) => c.kind === 'status' && !c.system_key);
  if (statusCols.length) {
    const ls = (await db.query('SELECT id, column_id, label FROM status_labels WHERE column_id = ANY($1::int[])', [statusCols.map((c) => c.id)])).rows;
    for (const c of statusCols) labelIds.set(c.id, new Map(ls.filter((l) => l.column_id === c.id).map((l) => [l.label.toLowerCase(), l.id])));
  }

  // Groups in one statement (sort_order = their place), then every item of every group in one more. A template
  // can carry hundreds of starter items and a remote database costs a round trip per query, so nothing here
  // may loop over queries (it used to, through createTodoCore, and the request timed out).
  const groups = def.groups?.length ? def.groups : [{ name: 'Group 1', color: 'blue' }];
  const groupRows = (await db.query(
    `INSERT INTO todo_sections (list_id, owner_id, business_id, board_id, name, description, sort_order, color)
     SELECT NULL, $1, $2, $3, g.name, '', g.ord, g.color
       FROM unnest($4::text[], $5::text[]) WITH ORDINALITY AS g(name, color, ord)
     RETURNING id, sort_order`,
    [actor.id, board.business_id, board.id, groups.map((g) => String(g.name).slice(0, 120)), groups.map((g) => (COLOR_NAMES.includes(g.color) ? g.color : 'blue'))]
  )).rows;
  const groupIdAt = new Map(groupRows.map((r) => [Number(r.sort_order), r.id]));

  let made = 0;
  if (withItems) {
    const flat = [];
    groups.forEach((g, i) => {
      for (const it of (g.items || []).slice(0, ITEM_LIMIT)) {
        const title = sanitizeText(it.title, 500);
        if (title) flat.push({ it, title, groupId: groupIdAt.get(i + 1) });
      }
    });
    if (flat.length) {
      const prio = (n) => { const v = parseInt(n, 10); return v >= 1 && v <= 4 ? v : 4; };
      const day = (d) => (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}/.test(d) ? d.slice(0, 10) : null);
      const ids = (await db.query(
        `INSERT INTO todos (created_by, title, notes, priority, due_date, start_date, business_id, board_id, business_section_id)
         SELECT $1, x.title, x.notes, x.priority, x.due::date, x.start::date, $2, $3, x.gid
           FROM unnest($4::text[], $5::text[], $6::int[], $7::text[], $8::text[], $9::int[]) WITH ORDINALITY AS x(title, notes, priority, due, start, gid, ord)
          ORDER BY x.ord
         RETURNING id`,
        [
          actor.id, board.business_id || null, board.id,
          flat.map((f) => f.title), flat.map((f) => sanitizeText(f.it.notes, 5000) || ''), flat.map((f) => prio(f.it.priority)),
          flat.map((f) => day(f.it.due_date)), flat.map((f) => day(f.it.start_date)), flat.map((f) => f.groupId),
        ]
      )).rows.map((r) => r.id);
      made = ids.length;
      // The maker is a member of each (a personal board's items sit in their own To-do; the Inbox until they are placed).
      await db.query(
        `INSERT INTO todo_members (todo_id, user_id, list_id, added_by)
         SELECT d, $2::int, NULL::int, $2::int FROM unnest($1::int[]) AS d ON CONFLICT DO NOTHING`,
        [ids, actor.id]
      );
      await db.query(
        `INSERT INTO todo_events (todo_id, user_id, subject_id, kind, meta)
         SELECT d, $2::int, $2::int, 'created', $3::jsonb FROM unnest($1::int[]) AS d`,
        [ids, actor.id, JSON.stringify({ parent_id: null, business_id: board.business_id || null, review_state: 'accepted', from_template: true })]
      );
      const vTodo = []; const vCol = []; const vVal = [];
      flat.forEach((f, i) => {
        for (const [title, raw] of Object.entries(f.it.values || {})) {
          const col = colIdByTitle.get(title.toLowerCase());
          if (!col || col.system_key) continue;
          let value = raw;
          if (col.kind === 'status' && raw?.label) value = { label_id: labelIds.get(col.id)?.get(String(raw.label).toLowerCase()) };
          const cleaned = cleanValue(col.kind, value, col.settings || {});
          if (cleaned.error || cleaned.value === null) continue;
          vTodo.push(ids[i]); vCol.push(col.id); vVal.push(JSON.stringify(cleaned.value));
        }
      });
      if (vTodo.length) {
        await db.query(
          `INSERT INTO item_values (todo_id, column_id, value, updated_by)
           SELECT t, c, v::jsonb, $4 FROM unnest($1::int[], $2::int[], $3::text[]) AS x(t, c, v) ON CONFLICT DO NOTHING`,
          [vTodo, vCol, vVal, actor.id]
        );
      }
    }
  }
  return { board, items: made };
}

module.exports = { definitionFromBoard, buildBoard, ITEM_LIMIT };
