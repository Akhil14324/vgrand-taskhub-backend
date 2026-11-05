const db = require('../db');
const { sanitizeText } = require('../middleware/sanitize');
const { cleanValue, cleanSettings, SYSTEM_COLUMNS } = require('../utils/columns');
const { worksIn } = require('../utils/org');
const { isAssignable } = require('./todoGovernance');
const S = require('../utils/sheetImport');

/**
 * Import rows from a spreadsheet (pasted cells, .xlsx or .csv read by the client) into a board as NEW tasks.
 * Nothing already on the board is changed. See POST /api/boards/:id/import.
 *
 * The client says, per sheet column, where it goes (`mapping[i]`):
 *   { to: 'skip' } | { to: 'name' } | { to: 'group' } | { to: 'column', column_id } | { to: 'new', title, kind, multiple? }
 * and sends the cells as text (`rows`: arrays in the same order). The server reads every cell for the column it
 * lands in (utils/sheetImport.js); a cell it cannot read is left empty and reported, the row is still added.
 * Only a row without a name is left out. A dry run answers what would happen and changes nothing.
 *
 * Missing groups are made (create_groups, default on). People who run the board (`manage`) also get new
 * columns, new status labels and new dropdown options made from the sheet's words; others get a warning.
 */

const MAX_ROWS = 5000;
const SLOW_MAX = 500; // rows through createTodoCore (My to-dos board, proposals)
const NOT_FROM_SHEET = new Set(['dependency', 'sprint', 'points', 'item_type', 'approval', 'time_tracking', 'item_id', 'created', 'updated']);

const WHAT = {
  numbers: 'is not a number', checkbox: 'is not yes or no', date: 'is not a date', timeline: 'is not a date range',
  week: 'is not a date', link: 'is not a web link', phone: 'is not a phone number', rating: 'is not a rating',
  progress: 'is not a percentage', hour: 'is not a time like 14:30', country: 'is not a two-letter country code',
};
const lower = (s) => String(s ?? '').trim().toLowerCase();
const cellText = (v) => (v === null || v === undefined ? '' : String(v));

async function loadContext(board, actor) {
  const mine = board.kind === 'my_todos';
  const [cols, labels, groups, existing] = await Promise.all([
    db.query('SELECT * FROM board_columns WHERE board_id = $1 AND archived_at IS NULL ORDER BY sort_order, id', [board.id]),
    db.query(`SELECT l.* FROM status_labels l JOIN board_columns c ON c.id = l.column_id
               WHERE c.board_id = $1 AND l.archived_at IS NULL ORDER BY l.sort_order, l.id`, [board.id]),
    mine
      ? db.query('SELECT id, name FROM todo_lists WHERE owner_id = $1 ORDER BY sort_order, id', [actor.id])
      : db.query('SELECT id, name FROM todo_sections WHERE board_id = $1 AND NOT archived ORDER BY sort_order, id', [board.id]),
    mine
      ? db.query(`SELECT lower(t.title) AS t FROM todos t JOIN todo_members m ON m.todo_id = t.id AND m.user_id = $1
                   WHERE t.business_id IS NULL`, [actor.id])
      : db.query('SELECT lower(title) AS t FROM todos WHERE board_id = $1', [board.id]),
  ]);
  // Who may be picked in a person cell: on a business board the people of that business (and leadership).
  const people = (await db.query(
    board.business_id
      ? `SELECT u.id, u.name, u.email, u.username FROM users u
          WHERE u.status != 'inactive' AND (u.org_level IS NOT NULL OR u.role IN ('admin', 'super_admin')
             OR EXISTS (SELECT 1 FROM user_businesses ub WHERE ub.user_id = u.id AND ub.business_id = $1)
             OR EXISTS (SELECT 1 FROM board_members bm WHERE bm.user_id = u.id AND bm.board_id = $2))`
      : `SELECT id, name, email, username FROM users WHERE status != 'inactive' AND $1::int >= 0 AND $2::int > 0`,
    [board.business_id || 0, board.id]
  )).rows;
  return {
    mine,
    columns: cols.rows.map((c) => ({ ...c, labels: labels.rows.filter((l) => l.column_id === c.id) })),
    groups: groups.rows,
    existing: new Set(existing.rows.map((r) => r.t)),
    people,
  };
}

/**
 * Reads every row against the mapping. Returns the plan (rows with fields and values), what would be made
 * (groups, columns, labels, options) and the warnings. Pure apart from `ctx`.
 */
function planImport(input, ctx, { manage, defaultGroupId }) {
  const mapping = (Array.isArray(input.mapping) ? input.mapping : []).slice(0, 200);
  const rows = (Array.isArray(input.rows) ? input.rows : []).slice(0, MAX_ROWS).map((r) => (Array.isArray(r) ? r : []));
  const dayFirst = input.date_order !== 'mdy';
  const thisYear = Number(new Date().toISOString().slice(0, 4));
  const dateOpts = { dayFirst, year: thisYear };
  const createGroups = input.create_groups !== false;
  const warnings = [];
  const notes = [];
  const warn = (row, column, text) => warnings.push({ row, column, text });

  const nameAt = mapping.findIndex((m) => m?.to === 'name');
  const groupAt = mapping.findIndex((m) => m?.to === 'group');
  if (nameAt < 0) return { error: 'Pick the sheet column that holds the task names' };

  // Targets: an existing column or a new one (made only when the person runs the board).
  const byId = new Map(ctx.columns.map((c) => [c.id, c]));
  const targets = mapping.map((m, i) => {
    if (!m || i === nameAt || i === groupAt) return null;
    if (m.to === 'column') {
      const col = byId.get(Number(m.column_id));
      if (!col) return null;
      if (col.system_key && (NOT_FROM_SHEET.has(col.system_key) || !SYSTEM_COLUMNS[col.system_key])) {
        notes.push(`${col.title} fills itself, so that sheet column is left out`);
        return null;
      }
      if (!col.system_key && ['files', 'board_relation', 'vote', 'formula', 'mirror', 'button', 'auto_number', 'creation_log', 'last_updated'].includes(col.kind)) {
        notes.push(`${col.title} cannot be filled from a sheet, so that sheet column is left out`);
        return null;
      }
      return { col, isNew: false };
    }
    if (m.to === 'new') {
      const kind = S.NEW_KINDS.includes(m.kind) ? m.kind : 'text';
      const title = sanitizeText(m.title, 120) || `Column ${i + 1}`;
      if (!manage) { notes.push(`Only the people who run this board can add columns, so "${title}" is left out`); return null; }
      return {
        isNew: true,
        col: { id: `new${i}`, kind, title, system_key: null, labels: [], settings: kind === 'dropdown' ? { options: [], multiple: !!m.multiple } : {} },
      };
    }
    return null;
  });

  // New labels / options found in the sheet, per column (kept in order of first appearance).
  const newLabels = new Map(); // column id -> Map(lower label -> label)
  const addNewLabel = (col, text) => {
    if (!newLabels.has(col.id)) newLabels.set(col.id, new Map());
    const m = newLabels.get(col.id);
    if (!m.has(lower(text))) m.set(lower(text), String(text).trim().slice(0, 60));
  };
  const groupByName = new Map(ctx.groups.map((g) => [lower(g.name), g]));
  const newGroups = new Map();

  const plan = [];
  let noName = 0;
  rows.forEach((r, ri) => {
    const rowNo = ri + 1;
    const title = sanitizeText(cellText(r[nameAt]).replace(/\s*\n\s*/g, ' '), 500);
    if (!title) { noName += 1; return; }
    const item = { row: rowNo, title, fields: {}, values: {}, raw: {}, group: null, newGroup: null, duplicate: ctx.existing.has(lower(title)) };

    if (groupAt >= 0) {
      const gname = sanitizeText(cellText(r[groupAt]), 120);
      if (gname) {
        const g = groupByName.get(lower(gname));
        if (g) item.group = g.id;
        else if (createGroups) { newGroups.set(lower(gname), gname); item.newGroup = lower(gname); } else warn(rowNo, 'Group', `"${gname}" is not a group here, so it goes to the first group`);
      }
    }
    if (!item.group && !item.newGroup) item.group = defaultGroupId || ctx.groups[0]?.id || null;

    targets.forEach((t, ci) => {
      if (!t) return;
      const raw = r[ci];
      const text = cellText(raw).trim();
      if (!text) return;
      const { col } = t;
      const say = (why) => warn(rowNo, col.title, `"${text.slice(0, 60)}" ${why}, so it is left empty`);

      if (col.system_key) {
        switch (col.system_key) {
          case 'status': {
            const hit = col.labels.find((l) => lower(l.label) === lower(text));
            const stage = hit?.maps_to || S.stageOf(text);
            if (stage) item.fields.status = stage; else say('is not one of the Status labels');
            break;
          }
          case 'person': {
            const { ids, unknown } = S.matchPeople(text, ctx.people);
            if (ids.length) item.fields.assignee_id = ids[0];
            if (ids.length > 1) warn(rowNo, col.title, 'Only one owner per task: the first one is used');
            if (!ids.length) say(unknown.length > 1 ? 'are not people on this board' : 'is not a person on this board');
            break;
          }
          case 'date': { const d = S.readDate(raw, dateOpts); if (d) item.fields.due_date = d; else say('is not a date'); break; }
          case 'deadline': { const d = S.readDate(raw, dateOpts); if (d) item.fields.deadline_date = d; else say('is not a date'); break; }
          case 'timeline': {
            const rg = S.readRange(raw, dateOpts);
            if (rg) { item.fields.start_date = rg.start; item.fields.timeline_end = rg.end; } else say('is not a date range');
            break;
          }
          case 'priority': { const p = S.readPriority(text); if (p) item.fields.priority = p; else say('is not a priority (Urgent, High, Medium, Low)'); break; }
          case 'estimate': { const n = S.readMinutes(raw); if (n) item.fields.duration_minutes = n; else say('is not a length of time'); break; }
          case 'labels': {
            const ls = S.splitList(text).map((x) => x.toLowerCase().replace(/^[#+@]+/, '').replace(/[^a-z0-9_-]/g, '').slice(0, 30)).filter(Boolean);
            if (ls.length) item.fields.labels = [...new Set(ls)].slice(0, 10);
            break;
          }
          default: break;
        }
        return;
      }

      // Custom columns.
      if (col.kind === 'status') {
        const hit = col.labels.find((l) => lower(l.label) === lower(text));
        if (hit) item.values[col.id] = { label_id: hit.id };
        else if (manage) { addNewLabel(col, text); item.raw[col.id] = { label: lower(text) }; } else say('is not one of the labels');
        return;
      }
      if (col.kind === 'dropdown') {
        const multiple = !!col.settings?.multiple;
        const words = multiple ? S.splitList(text) : [text];
        const opts = col.settings?.options || [];
        const ids = [];
        const fresh = [];
        for (const w of words) {
          const o = opts.find((x) => lower(x.label) === lower(w));
          if (o) ids.push(o.id); else if (manage) { addNewLabel(col, w); fresh.push(lower(w)); } else say('is not one of the options');
        }
        if (fresh.length) item.raw[col.id] = { options: ids, fresh };
        else if (ids.length) item.values[col.id] = multiple ? ids : [ids[0]];
        return;
      }
      if (col.kind === 'person') {
        const { ids, unknown } = S.matchPeople(text, ctx.people);
        if (ids.length) item.values[col.id] = ids.slice(0, 25);
        if (unknown.length) warn(rowNo, col.title, `${unknown.map((u) => `"${u}"`).join(', ')} not found among the people here`);
        return;
      }
      const v = S.readCustom(col.kind, raw, dateOpts);
      if (v === undefined) { say(WHAT[col.kind] || 'cannot be read here'); return; }
      if (v === null) return;
      const cleaned = cleanValue(col.kind, v, col.settings || {});
      if (cleaned.error) say(`(${cleaned.error})`);
      else if (cleaned.value !== null) item.values[col.id] = cleaned.value;
    });

    if (item.fields.timeline_end && !item.fields.due_date) item.fields.due_date = item.fields.timeline_end;
    delete item.fields.timeline_end;
    if (item.fields.start_date && item.fields.due_date && item.fields.start_date > item.fields.due_date) item.fields.start_date = item.fields.due_date;
    plan.push(item);
  });

  return {
    plan, warnings, notes, noName, rowsSeen: rows.length,
    targets, newGroups, newLabels,
    newColumns: targets.filter((t) => t?.isNew).map((t) => t.col),
  };
}

function summaryOf(p, skipDuplicates) {
  const dup = p.plan.filter((x) => x.duplicate).length;
  return {
    rows: p.rowsSeen,
    ready: p.plan.length - (skipDuplicates ? dup : 0),
    no_name: p.noName,
    duplicates: dup,
    warnings: p.warnings.length,
    new_groups: [...p.newGroups.values()],
    new_columns: p.newColumns.map((c) => ({ title: c.title, kind: c.kind })),
    new_labels: [...p.newLabels.entries()].map(([cid, m]) => ({
      column: (p.targets.find((t) => t?.col.id === cid) || {}).col?.title || '',
      labels: [...m.values()].slice(0, 30),
      more: Math.max(0, m.size - 30),
    })),
  };
}

/**
 * Makes what the plan needs (columns, labels, options, groups) and returns maps from the plan's placeholders
 * to real ids. Runs on `q` (a transaction client).
 */
async function makeStructure(q, board, actor, p, ctx) {
  const colId = new Map(); // placeholder 'new3' -> real id
  const realCol = new Map(); // id -> column row (with labels)
  for (const c of ctx.columns) realCol.set(c.id, c);
  if (p.newColumns.length) {
    let order = (await q.query('SELECT COALESCE(MAX(sort_order), 0) AS n FROM board_columns WHERE board_id = $1', [board.id])).rows[0].n;
    for (const c of p.newColumns) {
      order += 1;
      const width = { long_text: 220, text: 160, numbers: 110, checkbox: 90, date: 130, timeline: 180 }[c.kind] || 150;
      const row = (await q.query(
        `INSERT INTO board_columns (board_id, kind, title, width, sort_order, settings, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [board.id, c.kind, c.title, width, order, cleanSettings(c.kind, c.settings), actor.id]
      )).rows[0];
      colId.set(c.id, row.id);
      realCol.set(row.id, { ...row, labels: [] });
    }
  }
  const idOf = (cid) => (typeof cid === 'string' ? colId.get(cid) : cid);

  // New status labels and dropdown options, by lower-case word -> stored value.
  const labelId = new Map(); // real column id -> Map(lower -> label id | option id)
  for (const [cid, words] of p.newLabels.entries()) {
    const id = idOf(cid);
    const col = realCol.get(id);
    if (!col) continue;
    const m = new Map();
    if (col.kind === 'status') {
      let order = col.labels.length;
      for (const [k, label] of words.entries()) {
        order += 1;
        const r = (await q.query(
          'INSERT INTO status_labels (column_id, label, color, sort_order) VALUES ($1, $2, $3, $4) RETURNING id',
          [id, label, S.colorFor(label, order - 1), order]
        )).rows[0];
        m.set(k, r.id);
      }
    } else if (col.kind === 'dropdown') {
      const settings = { ...(col.settings || {}) };
      const opts = [...(settings.options || [])];
      const taken = new Set(opts.map((o) => String(o.id)));
      let n = opts.length;
      for (const [k, label] of words.entries()) {
        n += 1;
        let oid = `o${n}`;
        while (taken.has(oid)) oid = `${oid}_`;
        taken.add(oid);
        opts.push({ id: oid, label, color: S.colorFor(label, n - 1) });
        m.set(k, oid);
      }
      settings.options = opts.slice(0, 200);
      const clean = cleanSettings('dropdown', settings);
      await q.query('UPDATE board_columns SET settings = $1 WHERE id = $2', [clean, id]);
    }
    labelId.set(id, m);
  }

  const groupId = new Map(); // lower name -> id
  if (p.newGroups.size) {
    const names = [...p.newGroups.values()];
    if (ctx.mine) {
      let order = (await q.query('SELECT COALESCE(MAX(sort_order), 0) AS n FROM todo_lists WHERE owner_id = $1', [actor.id])).rows[0].n;
      for (const name of names) {
        order += 1;
        const r = (await q.query('INSERT INTO todo_lists (owner_id, name, color, sort_order) VALUES ($1, $2, $3, $4) RETURNING id', [actor.id, name, S.colorFor(name, order), order])).rows[0];
        groupId.set(lower(name), r.id);
      }
    } else {
      const start = (await q.query('SELECT COALESCE(MAX(sort_order), 0) AS n FROM todo_sections WHERE board_id = $1', [board.id])).rows[0].n;
      const rows = (await q.query(
        `INSERT INTO todo_sections (list_id, owner_id, business_id, board_id, name, description, sort_order, color)
         SELECT NULL, $1, $2, $3, g.name, '', $4 + g.ord, g.color
           FROM unnest($5::text[], $6::text[]) WITH ORDINALITY AS g(name, color, ord)
         RETURNING id, name`,
        [actor.id, board.business_id || null, board.id, start, names, names.map((n, i) => S.colorFor(n, i + 1))]
      )).rows;
      for (const r of rows) groupId.set(lower(r.name), r.id);
    }
  }
  return { idOf, labelId, groupId };
}

/** The custom values of one planned row, with placeholders replaced. */
function valuesOf(item, made) {
  const out = [];
  for (const [cid, v] of Object.entries(item.values)) {
    const id = made.idOf(/^new/.test(cid) ? cid : Number(cid));
    if (id) out.push([id, v]);
  }
  for (const [cid, r] of Object.entries(item.raw)) {
    const id = made.idOf(/^new/.test(cid) ? cid : Number(cid));
    const words = made.labelId.get(id);
    if (!id || !words) continue;
    if (r.label) { const l = words.get(r.label); if (l) out.push([id, { label_id: l }]); }
    if (r.fresh) {
      const ids = [...r.options, ...r.fresh.map((w) => words.get(w)).filter(Boolean)];
      if (ids.length) out.push([id, ids]);
    }
  }
  return out;
}

/** Runs the import. Returns { status, body }. */
async function runImport({ board, access, actor, input, createTodoCore }) {
  const ctx = await loadContext(board, actor);
  const defaultGroupId = Number(input.group_id) && ctx.groups.some((g) => g.id === Number(input.group_id)) ? Number(input.group_id) : null;
  const p = planImport(input, ctx, { manage: !!access.manage, defaultGroupId });
  if (p.error) return { status: 400, body: { error: p.error } };
  if (!p.rowsSeen) return { status: 400, body: { error: 'Nothing to import' } };
  const skipDuplicates = input.skip_duplicates !== false;
  const summary = summaryOf(p, skipDuplicates);
  const report = {
    summary,
    notes: p.notes,
    warnings: p.warnings.slice(0, 100),
    duplicates: p.plan.filter((x) => x.duplicate).slice(0, 50).map((x) => ({ row: x.row, title: x.title })),
  };
  if (input.dry_run) return { status: 200, body: report };

  const todo = p.plan.filter((x) => !(skipDuplicates && x.duplicate));
  // Business tasks by someone who does not work there are proposals: they go through the full to-do rules.
  const slow = ctx.mine || (board.business_id && !worksIn(actor, board.business_id));
  if (slow && todo.length > SLOW_MAX) {
    return { status: 400, body: { error: `Up to ${SLOW_MAX} rows at a time on this board. Split the sheet and import it in parts.` } };
  }

  // Business boards: an owner must be someone who may be given work there.
  if (board.business_id) {
    const owners = [...new Set(todo.map((x) => x.fields.assignee_id).filter(Boolean))];
    const ok = new Set();
    for (const id of owners) if (id === actor.id || (await isAssignable(id, board.business_id))) ok.add(id);
    for (const x of todo) {
      if (x.fields.assignee_id && !ok.has(x.fields.assignee_id)) {
        report.warnings.push({ row: x.row, column: 'Owner', text: 'That person is not part of this business, so the task has no owner' });
        delete x.fields.assignee_id;
      }
    }
  }

  const client = await db.pool.connect();
  let ids = [];
  let made;
  try {
    await client.query('BEGIN');
    made = await makeStructure(client, board, actor, p, ctx);
    const gid = (x) => (x.newGroup ? made.groupId.get(x.newGroup) : x.group) || null;

    if (!slow && todo.length) {
      const biz = board.business_id || null;
      const f = (k) => todo.map((x) => x.fields[k] ?? null);
      const assignee = todo.map((x) => x.fields.assignee_id || (biz ? null : actor.id));
      const status = todo.map((x) => x.fields.status || 'todo');
      ids = (await client.query(
        `INSERT INTO todos (created_by, title, notes, priority, due_date, start_date, deadline_date, duration_minutes, labels,
                            assignee_id, assigned_at, business_id, board_id, business_section_id, review_state, requires_approval,
                            status, status_since, started_at, is_done, done_at, done_by)
         SELECT $1, x.title, '', x.priority, x.due::date, x.start::date, x.deadline::date, x.dur,
                ARRAY(SELECT jsonb_array_elements_text(x.labels::jsonb)),
                x.assignee, CASE WHEN x.assignee IS NOT NULL THEN NOW() END, $2, $3, x.gid, 'accepted',
                ($2::int IS NOT NULL AND x.assignee IS NOT NULL AND x.assignee <> $1 AND x.status <> 'done'),
                x.status, NOW(), CASE WHEN x.status = 'in_progress' THEN NOW() END,
                x.status = 'done', CASE WHEN x.status = 'done' THEN NOW() END, CASE WHEN x.status = 'done' THEN $1::int END
           FROM unnest($4::text[], $5::int[], $6::text[], $7::text[], $8::text[], $9::int[], $10::text[], $11::int[], $12::int[], $13::text[])
                WITH ORDINALITY AS x(title, priority, due, start, deadline, dur, labels, assignee, gid, status, ord)
          ORDER BY x.ord
         RETURNING id`,
        [
          actor.id, biz, board.id,
          todo.map((x) => x.title), todo.map((x) => x.fields.priority || 4), f('due_date'), f('start_date'), f('deadline_date'),
          f('duration_minutes'), todo.map((x) => JSON.stringify(x.fields.labels || [])), assignee, todo.map(gid), status,
        ]
      )).rows.map((r) => r.id);

      // Members: the importer, and the owner when it is someone else (it lands in their To-do).
      const mTodo = []; const mUser = [];
      ids.forEach((id, i) => {
        mTodo.push(id); mUser.push(actor.id);
        if (assignee[i] && assignee[i] !== actor.id) { mTodo.push(id); mUser.push(assignee[i]); }
      });
      await client.query(
        `INSERT INTO todo_members (todo_id, user_id, list_id, added_by)
         SELECT t, u, NULL::int, $3::int FROM unnest($1::int[], $2::int[]) AS x(t, u) ON CONFLICT DO NOTHING`,
        [mTodo, mUser, actor.id]
      );
      await client.query(
        `INSERT INTO todo_events (todo_id, user_id, subject_id, kind, meta)
         SELECT t, $2::int, COALESCE(a, $2::int), 'created', $4::jsonb FROM unnest($1::int[], $3::int[]) AS x(t, a)`,
        [ids, actor.id, assignee, JSON.stringify({ parent_id: null, business_id: biz, review_state: 'accepted', from_import: true })]
      );
      // "Stuck" in the sheet: a blocker says why, so the task reads as stuck everywhere.
      const stuck = ids.filter((_, i) => status[i] === 'blocked');
      if (stuck.length) {
        await client.query(
          `INSERT INTO todo_blockers (todo_id, kind, note, raised_by, mentions)
           SELECT t, 'issue', 'Marked as stuck in the imported sheet', $2, '[]' FROM unnest($1::int[]) AS t`,
          [stuck, actor.id]
        );
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  // The slow path: one by one through the to-do rules (outside the transaction: createTodoCore uses the pool).
  if (slow) {
    for (const x of todo) {
      const gidOf = (x.newGroup ? made.groupId.get(x.newGroup) : x.group) || null;
      const out = await createTodoCore(actor, {
        title: x.title,
        priority: x.fields.priority, due_date: x.fields.due_date, start_date: x.fields.start_date,
        deadline_date: x.fields.deadline_date, duration_minutes: x.fields.duration_minutes, labels: x.fields.labels,
        board_id: ctx.mine ? undefined : board.id, business_id: board.business_id || undefined,
        business_section_id: board.business_id ? gidOf : undefined, list_id: ctx.mine ? gidOf : undefined,
        assign_to: board.business_id ? x.fields.assignee_id : undefined, mention_ids: [],
      }, { quiet: true });
      ids.push(out.todo?.id || out.id || null);
    }
    // The sheet's status, for accepted to-dos (a proposal waits for review first).
    const st = todo.map((x, i) => [ids[i], x.fields.status]).filter(([id, s]) => id && s && s !== 'todo');
    if (st.length) {
      await db.query(
        `UPDATE todos t SET status = x.s, status_since = NOW(),
                started_at = CASE WHEN x.s = 'in_progress' THEN NOW() ELSE t.started_at END,
                is_done = x.s = 'done', done_at = CASE WHEN x.s = 'done' THEN NOW() END, done_by = CASE WHEN x.s = 'done' THEN $3::int END
           FROM unnest($1::int[], $2::text[]) AS x(id, s)
          WHERE t.id = x.id AND t.review_state = 'accepted' AND x.s <> 'blocked'`,
        [st.map((r) => r[0]), st.map((r) => r[1]), actor.id]
      );
    }
  }

  // Custom values in one statement.
  const vTodo = []; const vCol = []; const vVal = [];
  todo.forEach((x, i) => {
    if (!ids[i]) return;
    for (const [cid, v] of valuesOf(x, made)) { vTodo.push(ids[i]); vCol.push(cid); vVal.push(JSON.stringify(v)); }
  });
  if (vTodo.length) {
    await db.query(
      `INSERT INTO item_values (todo_id, column_id, value, updated_by)
       SELECT t, c, v::jsonb, $4 FROM unnest($1::int[], $2::int[], $3::text[]) AS x(t, c, v) ON CONFLICT DO NOTHING`,
      [vTodo, vCol, vVal, actor.id]
    );
  }

  const created = ids.filter(Boolean);
  const owners = new Map();
  todo.forEach((x, i) => {
    const a = x.fields.assignee_id;
    if (ids[i] && a && a !== actor.id && x.fields.status !== 'done') owners.set(a, [...(owners.get(a) || []), { id: ids[i], title: x.title }]);
  });
  return { status: 201, body: { ...report, created: created.length }, created, owners };
}

module.exports = { runImport, planImport, MAX_ROWS };
