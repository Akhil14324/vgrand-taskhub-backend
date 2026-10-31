/**
 * Dashboard widgets (MONDAY_FEATURE_SPEC.md F-DSH-03 .. F-DSH-12): what one widget shows, from the items of the
 * dashboard's boards that the viewer can see. Pure (no database), so it is unit-tested.
 *
 * kinds: numbers (a count or a sum), chart (counts by status / person / board / priority), battery (done of total),
 *        status (by stage), workload (open and late per person), upcoming (next dated), overdue (late items), text
 */

const STAGES = [
  ['todo', 'Not started', 'grey'], ['in_progress', 'Working on it', 'orange'], ['blocked', 'Stuck', 'red'],
  ['in_review', 'In review', 'blue'], ['on_hold', 'On hold', 'purple'], ['done', 'Done', 'green'],
];
const PRIORITY = { 1: ['Urgent', 'red'], 2: ['High', 'orange'], 3: ['Normal', 'blue'], 4: ['Low', 'grey'] };

const dueOf = (t) => [t.due_date, t.deadline_date].filter(Boolean).sort()[0] || null;

/** Items a widget's filter keeps: all | open | done | overdue | mine | this_week. */
function filterItems(items, filter, { today, meId, weekEnd }) {
  const top = items.filter((t) => !t.parent_id);
  switch (filter) {
    case 'open': return top.filter((t) => !t.is_done);
    case 'done': return top.filter((t) => t.is_done);
    case 'overdue': return top.filter((t) => !t.is_done && dueOf(t) && dueOf(t) < today);
    case 'mine': return top.filter((t) => t.assignee_id === meId);
    case 'this_week': return top.filter((t) => dueOf(t) && dueOf(t) >= today && dueOf(t) <= weekEnd);
    default: return top;
  }
}

function countBy(items, keyOf) {
  const m = new Map();
  for (const t of items) {
    const [key, label, color] = keyOf(t);
    const cur = m.get(key) || { key, label, color, count: 0 };
    cur.count += 1;
    m.set(key, cur);
  }
  return [...m.values()].sort((a, b) => b.count - a.count);
}

/**
 * One widget's data. ctx = { today, weekEnd, meId, boards: Map(id -> name), values: { [todoId]: { [colId]: v } },
 *                            columnIdsByTitle: Map(lowerTitle -> [colId]) }
 */
function computeWidget(kind, config = {}, items, ctx) {
  const scoped = filterItems(items, config.filter || 'all', ctx);
  switch (kind) {
    case 'numbers': {
      if (config.column) {
        const ids = ctx.columnIdsByTitle.get(String(config.column).toLowerCase()) || [];
        let sum = 0;
        for (const t of scoped) for (const id of ids) { const v = ctx.values[t.id]?.[id]; if (typeof v === 'number') sum += v; }
        return { value: sum, unit: config.unit || '' };
      }
      return { value: scoped.length };
    }
    case 'battery': {
      const top = filterItems(items, config.filter === 'mine' ? 'mine' : 'all', ctx);
      const done = top.filter((t) => t.is_done).length;
      return { done, total: top.length, percent: top.length ? Math.round((done / top.length) * 100) : 0 };
    }
    case 'status':
      return { bars: STAGES.map(([key, label, color]) => ({ key, label, color, count: scoped.filter((t) => t.status === key).length })).filter((b) => b.count) };
    case 'chart': {
      const by = config.by || 'status';
      const bars = by === 'person'
        ? countBy(scoped, (t) => [t.assignee_id || 0, t.assignee_name || 'Nobody', 'blue'])
        : by === 'board'
          ? countBy(scoped, (t) => [t.board_id || 0, ctx.boards.get(t.board_id) || 'No board', 'purple'])
          : by === 'priority'
            ? countBy(scoped, (t) => [t.priority || 4, ...(PRIORITY[t.priority] || PRIORITY[4])])
            : countBy(scoped, (t) => { const s = STAGES.find((x) => x[0] === t.status) || STAGES[0]; return [s[0], s[1], s[2]]; });
      return { by, bars };
    }
    case 'workload': {
      const open = items.filter((t) => !t.parent_id && !t.is_done && t.assignee_id);
      const m = new Map();
      for (const t of open) {
        const r = m.get(t.assignee_id) || { id: t.assignee_id, name: t.assignee_name || 'Someone', open: 0, overdue: 0 };
        r.open += 1;
        if (dueOf(t) && dueOf(t) < ctx.today) r.overdue += 1;
        m.set(t.assignee_id, r);
      }
      return { people: [...m.values()].sort((a, b) => b.open - a.open).slice(0, 20) };
    }
    case 'upcoming':
      return {
        items: scoped.filter((t) => !t.is_done && dueOf(t) && dueOf(t) >= ctx.today)
          .sort((a, b) => dueOf(a).localeCompare(dueOf(b))).slice(0, Math.min(Number(config.limit) || 8, 20))
          .map((t) => ({ id: t.id, title: t.title, due: dueOf(t), who: t.assignee_name || null, board: ctx.boards.get(t.board_id) || null })),
      };
    case 'overdue':
      return {
        items: filterItems(items, 'overdue', ctx).sort((a, b) => dueOf(a).localeCompare(dueOf(b))).slice(0, 20)
          .map((t) => ({ id: t.id, title: t.title, due: dueOf(t), who: t.assignee_name || null, board: ctx.boards.get(t.board_id) || null })),
      };
    case 'text':
      return { text: String(config.text || '').slice(0, 2000) };
    default:
      return { error: 'Unknown widget' };
  }
}

module.exports = { computeWidget, filterItems, STAGES };
