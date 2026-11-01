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

const DAY = 86400000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const CHART_COLORS = ['blue', 'green', 'orange', 'purple', 'red', 'aquamarine', 'pink', 'yellow', 'indigo', 'grass'];
const ymd = (v) => (v ? String(v).slice(0, 10) : null);
/** Monday of the week of a 'YYYY-MM-DD'. */
function weekStart(d) {
  const t = Date.parse(`${d}T00:00:00Z`);
  return new Date(t - ((new Date(t).getUTCDay() + 6) % 7) * DAY).toISOString().slice(0, 10);
}
const shortDay = (d) => `${MONTHS[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}`;

/**
 * What a chart can split by. Each returns [key, label, color, sortKey]; time ones sort in time order and leave
 * items without that date in "No date" at the end.
 */
const TIME_DIMS = {
  due_day: [(t) => ymd(dueOf(t)), (d) => d, shortDay],
  due_week: [(t) => (dueOf(t) ? weekStart(dueOf(t)) : null), (d) => d, (d) => `Week of ${shortDay(d)}`],
  due_month: [(t) => (dueOf(t) ? dueOf(t).slice(0, 7) : null), (d) => d, (d) => `${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`],
  created_week: [(t) => (ymd(t.created_at) ? weekStart(ymd(t.created_at)) : null), (d) => d, (d) => `Week of ${shortDay(d)}`],
  done_week: [(t) => (ymd(t.done_at) ? weekStart(ymd(t.done_at)) : null), (d) => d, (d) => `Week of ${shortDay(d)}`],
};
function dimOf(dim, t, ctx) {
  if (TIME_DIMS[dim]) {
    const [get, sort, label] = TIME_DIMS[dim];
    const d = get(t);
    return d ? [d, label(d), 'blue', sort(d)] : ['none', 'No date', 'grey', '\uffff'];
  }
  switch (dim) {
    case 'person': return [t.assignee_id || 0, t.assignee_name || 'Nobody', null, null];
    case 'board': return [t.board_id || 0, ctx.boards.get(t.board_id) || 'No board', null, null];
    case 'priority': { const p = PRIORITY[t.priority] || PRIORITY[4]; return [t.priority || 4, p[0], p[1], t.priority || 4]; }
    default: { const i = Math.max(0, STAGES.findIndex((x) => x[0] === t.status)); return [STAGES[i][0], STAGES[i][1], STAGES[i][2], i]; }
  }
}

/**
 * The numbers behind every chart type: categories along the axis and one series per value of `series` (or one
 * series named "Items" when there is no split). values[i] belongs to categories[i].
 */
function chartMatrix(items, by, seriesBy, ctx) {
  const timeAxis = !!TIME_DIMS[by];
  const cats = new Map();
  const sers = new Map();
  const cell = new Map();
  for (const t of items) {
    const [ck, cl, cc, cs] = dimOf(by, t, ctx);
    const [sk, sl, sc] = seriesBy ? dimOf(seriesBy, t, ctx) : ['all', 'Items', 'blue'];
    const c = cats.get(ck) || { key: ck, label: cl, color: cc, sort: cs, total: 0 };
    c.total += 1; cats.set(ck, c);
    const se = sers.get(sk) || { key: sk, label: sl, color: sc, total: 0 };
    se.total += 1; sers.set(sk, se);
    cell.set(`${ck}|${sk}`, (cell.get(`${ck}|${sk}`) || 0) + 1);
  }
  let categories = [...cats.values()];
  categories.sort(timeAxis || by === 'status' || by === 'priority'
    ? (a, b) => (a.sort < b.sort ? -1 : a.sort > b.sort ? 1 : 0)
    : (a, b) => b.total - a.total);
  categories = categories.slice(0, timeAxis ? 24 : 14);
  let series = [...sers.values()].sort((a, b) => b.total - a.total);
  const keep = series.slice(0, 8);
  const rest = series.slice(8);
  series = keep.map((x, i) => ({ ...x, color: x.color || CHART_COLORS[i % CHART_COLORS.length] }));
  const out = series.map((x) => ({ key: x.key, label: x.label, color: x.color, values: categories.map((c) => cell.get(`${c.key}|${x.key}`) || 0) }));
  if (rest.length) out.push({ key: 'others', label: 'Others', color: 'grey', values: categories.map((c) => rest.reduce((n, r) => n + (cell.get(`${c.key}|${r.key}`) || 0), 0)) });
  return { categories: categories.map(({ key, label, color }) => ({ key, label, color })), series: out };
}

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
      const matrix = chartMatrix(scoped, by, config.series && config.series !== by ? config.series : null, ctx);
      const bars = by === 'person'
        ? countBy(scoped, (t) => [t.assignee_id || 0, t.assignee_name || 'Nobody', 'blue'])
        : by === 'board'
          ? countBy(scoped, (t) => [t.board_id || 0, ctx.boards.get(t.board_id) || 'No board', 'purple'])
          : by === 'priority'
            ? countBy(scoped, (t) => [t.priority || 4, ...(PRIORITY[t.priority] || PRIORITY[4])])
            : countBy(scoped, (t) => { const s = STAGES.find((x) => x[0] === t.status) || STAGES[0]; return [s[0], s[1], s[2]]; });
      return { by, series_by: config.series || null, bars, ...matrix };
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

module.exports = { computeWidget, filterItems, STAGES, chartMatrix };
