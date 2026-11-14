/**
 * Board dashboards (a view tab whose settings hold `widgets`). The widgets are computed on the client from the
 * board's own items; the server only keeps them safe and builds the AI request. Pure, unit-tested.
 */
const TYPES = ['number', 'chart', 'table', 'progress', 'list', 'text'];
const AGGS = ['count', 'sum', 'avg', 'min', 'max'];
const FILTERS = ['all', 'open', 'done', 'overdue', 'mine', 'this_week', 'due_today', 'working', 'stuck', 'unassigned', 'no_date', 'done_week'];
const METRICS = ['on_time', 'finish_days', 'late_days', 'done_7', 'new_7', 'steps', 'load'];
const CHARTS = ['column', 'bar', 'line', 'smooth_line', 'stacked_column', 'stacked_bar', 'pct_stacked_column', 'pie', 'donut'];
const BUILTIN_DIMS = ['status', 'person', 'group', 'priority', 'due_week', 'due_month', 'created_week', 'done_week', 'due_bucket', 'age', 'on_time', 'flow'];

/** Widget list made safe. With `schema` ({ columns: [{id}] }) unknown column ids are dropped too. */
function cleanWidgets(raw, schema = null) {
  const colIds = schema ? new Set(schema.columns.map((c) => String(c.id))) : null;
  const dimOk = (d) => typeof d === 'string' && (BUILTIN_DIMS.includes(d) || (/^col:\d+$/.test(d) && (!colIds || colIds.has(d.slice(4)))));
  const seen = new Set();
  return (Array.isArray(raw) ? raw : []).slice(0, 40).map((x, i) => {
    if (!x || typeof x !== 'object' || !TYPES.includes(x.type)) return null;
    let id = String(x.id || `w${i}${Math.random().toString(36).slice(2, 6)}`).replace(/[^\w-]/g, '').slice(0, 20) || `w${i}`;
    if (seen.has(id)) id = `${id}${i}`;
    seen.add(id);
    const w = { id, type: x.type, title: String(x.title || '').slice(0, 80), w: Math.min(3, Math.max(1, parseInt(x.w, 10) || 1)) };
    if (FILTERS.includes(x.filter)) w.filter = x.filter;
    if (x.type === 'number' && METRICS.includes(x.metric)) w.metric = x.metric;
    if (AGGS.includes(x.agg)) w.agg = x.agg;
    if (x.value && /^\d+$/.test(String(x.value)) && (!colIds || colIds.has(String(x.value)))) w.value = String(x.value);
    if (dimOk(x.by)) w.by = x.by;
    if (dimOk(x.series)) w.series = x.series;
    if (CHARTS.includes(x.chart)) w.chart = x.chart;
    if (typeof x.formula === 'string' && x.formula.trim()) w.formula = x.formula.slice(0, 200);
    if (typeof x.text === 'string' && x.text) w.text = x.text.slice(0, 2000);
    if (Number.isInteger(x.limit)) w.limit = Math.min(20, Math.max(1, x.limit));
    return w;
  }).filter(Boolean);
}

const SYSTEM = `You edit a dashboard for a work board. A dashboard is a list of widgets. Reply ONLY as JSON: {"widgets":[...],"summary":"one short sentence saying what you changed"}.
Return the COMPLETE new widget list (keep every widget the person did not ask to change, with its id).
Widget fields: id (keep existing ids, invent short ones for new), type, title, w (1-3, how many of 3 columns wide).
type "number": filter, or metric (on_time = % finished by the due date, finish_days = average days from added to done, late_days = average days overdue, done_7 = finished in the last 7 days, new_7 = added in the last 7 days, steps = % of steps done, load = open tasks per person), or optional value (numeric column id) + agg (count|sum|avg|min|max), or formula like "SUM(Budget) / COUNT()" (functions COUNT(), OPEN(), DONE(), OVERDUE(), SUM(col), AVG(col), MIN(col), MAX(col), PERCENT(a,b); columns by heading).
type "chart": chart (column|bar|line|smooth_line|stacked_column|stacked_bar|pct_stacked_column|pie|donut), by (a dimension key), optional series (a dimension key), optional value + agg, filter.
type "table": by (rows), optional series (columns), optional value + agg, filter.
type "progress": share of tasks done. type "list": filter (overdue|open|this_week), limit. type "text": text.
filter is one of all|open|done|overdue|mine|this_week|due_today|working|stuck|unassigned|no_date|done_week. Built-in dimension keys also include due_bucket (overdue, today, this week, later), age (how old open tasks are), on_time (on time or late), done_week, and flow (chart "by" only: added against finished per week). Only use dimension keys and column ids from the schema. Never invent data.`;

function aiPrompt({ request, widgets, schema }) {
  return {
    system: SYSTEM,
    user: `Board schema: ${JSON.stringify(schema)}\n\nCurrent widgets: ${JSON.stringify(widgets || [])}\n\nRequest: ${String(request).slice(0, 1000)}`,
  };
}

module.exports = { cleanWidgets, aiPrompt, TYPES, CHARTS };
