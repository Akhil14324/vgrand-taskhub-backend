const { evaluate, ExprError } = require('./automation/expr');

/**
 * Columns that fill themselves (MONDAY_FEATURE_SPEC.md F-COL-22, F-COL-24): Formula and Mirror. Pure, so it is
 * unit-tested; routes/boards.js feeds it the board's items, columns and values.
 *
 * A formula names other columns in braces: {Cost} * {Qty}, days({Start}, {Due date}), if({Status} == "Done", 1, 0).
 * It runs in the safe expression language of automations (utils/automation/expr.js): no JavaScript is evaluated.
 */

const STATUS_NAMES = {
  todo: 'Not started', in_progress: 'Working on it', blocked: 'Stuck', in_review: 'In review', on_hold: 'On hold', done: 'Done',
};

const SYSTEM_FIELD = {
  status: 'status', person: 'assignee_id', date: 'due_date', deadline: 'deadline_date', priority: 'priority',
  estimate: 'duration_minutes', labels: 'labels', points: 'story_points', item_id: 'id', created: 'created_at', updated: 'updated_at',
};

/** The plain value of one cell, as a formula or a mirror sees it (numbers stay numbers, labels become text). */
function plainValue(item, column, values, nameOf = () => '') {
  const key = column.system_key;
  if (key === 'timeline') return [item.start_date || '', item.due_date || ''].join(' - ');
  if (key) {
    const v = item[SYSTEM_FIELD[key]];
    if (key === 'status') {
      const label = (column.labels || []).find((l) => l.maps_to === v);
      return label ? label.label : STATUS_NAMES[v] || v || '';
    }
    if (key === 'person') return v ? (item.assignee_name || nameOf(v)) : '';
    if (key === 'labels') return Array.isArray(v) ? v.join(',') : '';
    return v ?? '';
  }
  const v = values?.[item.id]?.[column.id];
  if (v === null || v === undefined) return column.kind === 'numbers' || column.kind === 'rating' || column.kind === 'progress' ? 0 : '';
  switch (column.kind) {
    case 'status': return (column.labels || []).find((l) => l.id === v.label_id)?.label || '';
    case 'person': return (v || []).map(nameOf).filter(Boolean).join(',');
    case 'date': return v.date || '';
    case 'timeline': return `${v.start} - ${v.end}`;
    case 'dropdown': return (v || []).map((id) => (column.settings?.options || []).find((o) => o.id === id)?.label).filter(Boolean).join(',');
    case 'tags': return (v || []).join(',');
    case 'checkbox': return v === true;
    case 'link': return v.url || '';
    case 'location': return v.address || '';
    case 'files': case 'board_relation': case 'vote': return Array.isArray(v) ? v.length : 0;
    default: return v;
  }
}

/** "{Cost} * {Qty}" -> "%c12 * %c13". Unknown names are reported, not guessed. */
function formulaSource(expression, columns) {
  const byName = new Map(columns.map((c) => [c.title.trim().toLowerCase(), c]));
  const missing = [];
  const src = String(expression || '').replace(/\{([^{}]{1,120})\}/g, (_, name) => {
    const n = name.trim().toLowerCase();
    if (n === 'item' || n === 'name') return '%item';
    const col = byName.get(n);
    if (!col) { missing.push(name.trim()); return '""'; }
    return `%c${col.id}`;
  });
  return { src, missing };
}

/** Formula results per item: { [todoId]: { [columnId]: value | { error } } }. One formula may use another's result. */
function computeFormulas(items, columns, values, nameOf) {
  const formulas = columns.filter((c) => c.kind === 'formula' && c.settings?.expression);
  const out = {};
  if (!formulas.length) return out;
  const prepared = formulas.map((c) => ({ col: c, ...formulaSource(c.settings.expression, columns) }));
  for (const item of items) {
    const results = {};
    let filled = false; // did any column the formula reads have a value? (all empty -> blank, not 0)
    const has = (col) => {
      if (col.system_key) return item[SYSTEM_FIELD[col.system_key]] !== null && item[SYSTEM_FIELD[col.system_key]] !== undefined;
      const v = values?.[item.id]?.[col.id];
      return v !== null && v !== undefined && v !== '';
    };
    const lookup = (name) => {
      if (name === 'item') { filled = true; return item.title; }
      const m = /^c(\d+)$/.exec(name);
      if (!m) return undefined;
      const id = Number(m[1]);
      if (results[id] !== undefined) {
        if (results[id] && results[id].error) return '';
        if (results[id] !== '') filled = true;
        return results[id];
      }
      const col = columns.find((c) => c.id === id);
      if (!col) return '';
      if (col.kind === 'formula') return ''; // a formula that refers to a later formula, or to itself, sees blank
      if (has(col) || col.system_key === 'timeline') filled = true;
      return plainValue(item, col, values, nameOf);
    };
    for (const p of prepared) {
      if (p.missing.length) { results[p.col.id] = { error: `No column called ${p.missing.join(', ')}` }; continue; }
      try {
        filled = false;
        let v = evaluate(p.src, lookup);
        if (!filled && !/%item/.test(p.src)) v = '';
        results[p.col.id] = typeof v === 'number' && !Number.isFinite(v) ? { error: 'Not a number' } : v;
      } catch (err) {
        results[p.col.id] = { error: err instanceof ExprError ? err.message : 'This formula does not work' };
      }
    }
    out[item.id] = results;
  }
  return out;
}

/**
 * Mirror results: a mirror column shows, for each linked item (through a Connect-boards column), that item's
 * value in the target column. `linked` = { items, columns, values } of the boards the links point to.
 */
function computeMirrors(items, columns, values, linked, nameOf) {
  const mirrors = columns.filter((c) => c.kind === 'mirror' && c.settings?.relation_column_id && c.settings?.target_column_id);
  const out = {};
  if (!mirrors.length) return out;
  const byId = new Map((linked.items || []).map((t) => [t.id, t]));
  const targetCol = (id) => (linked.columns || []).find((c) => c.id === id);
  for (const item of items) {
    const res = {};
    for (const m of mirrors) {
      const ids = values?.[item.id]?.[m.settings.relation_column_id] || [];
      const col = targetCol(m.settings.target_column_id);
      res[m.id] = col
        ? ids.map((id) => byId.get(id)).filter(Boolean).map((t) => plainValue(t, col, linked.values, nameOf)).filter((v) => v !== '' && v !== null)
        : [];
    }
    out[item.id] = res;
  }
  return out;
}

module.exports = { plainValue, formulaSource, computeFormulas, computeMirrors };
