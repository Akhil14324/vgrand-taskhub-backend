/**
 * Board columns: every column type, the colour palette, the defaults of a new board, and the validation of a
 * cell value. Pure (no database), unit-tested, and served to the client by GET /api/boards/catalog so the
 * client draws its pickers from the same list.
 *
 * A column is either built in (system_key set: it reads and writes a todos field through the existing to-do
 * endpoints, so every rule and notification still applies) or custom (its value lives in item_values and is
 * written through PUT /api/boards/:id/items/:todoId/values/:columnId, validated by cleanValue below).
 */

// Named colours (MONDAY_FEATURE_SPEC.md F-DSN-01). `ink` is the text colour that stays readable on it.
const PALETTE = {
  green: { hex: '#00C875', ink: 'dark' },
  orange: { hex: '#FDAB3D', ink: 'dark' },
  red: { hex: '#DF2F4A', ink: 'light' },
  grey: { hex: '#C4C4C4', ink: 'dark' },
  blue: { hex: '#579BFC', ink: 'dark' },
  purple: { hex: '#A25DDC', ink: 'light' },
  dark_green: { hex: '#037F4C', ink: 'light' },
  grass: { hex: '#9CD326', ink: 'dark' },
  yellow: { hex: '#FFCB00', ink: 'dark' },
  dark_orange: { hex: '#FF6D3B', ink: 'dark' },
  pink: { hex: '#FF158A', ink: 'light' },
  berry: { hex: '#BB3354', ink: 'light' },
  lipstick: { hex: '#FF5AC4', ink: 'dark' },
  dark_purple: { hex: '#784BD1', ink: 'light' },
  indigo: { hex: '#5559DF', ink: 'light' },
  dark_blue: { hex: '#007EB5', ink: 'light' },
  sky: { hex: '#66CCFF', ink: 'dark' },
  aquamarine: { hex: '#4ECCC6', ink: 'dark' },
  brown: { hex: '#7F5347', ink: 'light' },
  black: { hex: '#333333', ink: 'light' },
};
const COLOR_NAMES = Object.keys(PALETTE);

const STATUS_KEYS = ['todo', 'in_progress', 'blocked', 'in_review', 'on_hold', 'done'];

/**
 * Column types. `value` says what a custom cell stores; `computed` types have no stored value (worked out
 * from other data); `system` types exist only as built-in columns. `icon` is an Ionicons name.
 */
const KINDS = {
  status: { label: 'Status', icon: 'ellipse-outline', value: 'label' },
  person: { label: 'Person', icon: 'person-circle-outline', value: 'people' },
  date: { label: 'Date', icon: 'calendar-outline', value: 'date' },
  timeline: { label: 'Timeline', icon: 'git-commit-outline', value: 'range' },
  dropdown: { label: 'Dropdown', icon: 'chevron-down-circle-outline', value: 'options' },
  tags: { label: 'Tags', icon: 'pricetags-outline', value: 'tags' },
  text: { label: 'Text', icon: 'text-outline', value: 'text' },
  long_text: { label: 'Long text', icon: 'reader-outline', value: 'long_text' },
  numbers: { label: 'Numbers', icon: 'calculator-outline', value: 'number' },
  checkbox: { label: 'Checkbox', icon: 'checkbox-outline', value: 'boolean' },
  link: { label: 'Link', icon: 'link-outline', value: 'link' },
  email: { label: 'Email', icon: 'mail-outline', value: 'email' },
  phone: { label: 'Phone', icon: 'call-outline', value: 'phone' },
  rating: { label: 'Rating', icon: 'star-outline', value: 'rating' },
  progress: { label: 'Progress', icon: 'battery-half-outline', value: 'percent' },
  hour: { label: 'Hour', icon: 'time-outline', value: 'hour' },
  week: { label: 'Week', icon: 'calendar-number-outline', value: 'week' },
  location: { label: 'Location', icon: 'location-outline', value: 'location' },
  country: { label: 'Country', icon: 'flag-outline', value: 'country' },
  color: { label: 'Color picker', icon: 'color-palette-outline', value: 'color' },
  world_clock: { label: 'World clock', icon: 'globe-outline', value: 'timezone' },
  files: { label: 'Files', icon: 'attach-outline', value: 'files' },
  board_relation: { label: 'Connect boards', icon: 'swap-horizontal-outline', value: 'items' },
  vote: { label: 'Vote', icon: 'thumbs-up-outline', value: 'voters' },
  // Filled by OpenAI from other columns (F-MORE-01); a person may also overwrite the text by hand.
  ai: { label: 'AI', icon: 'sparkles-outline', value: 'long_text' },
  button: { label: 'Button', icon: 'radio-button-on-outline', computed: true },
  formula: { label: 'Formula', icon: 'flask-outline', computed: true },
  mirror: { label: 'Mirror', icon: 'copy-outline', computed: true },
  auto_number: { label: 'Item ID', icon: 'barcode-outline', computed: true },
  creation_log: { label: 'Creation log', icon: 'create-outline', computed: true },
  last_updated: { label: 'Last updated', icon: 'refresh-outline', computed: true },
  priority: { label: 'Priority', icon: 'flag-outline', system: true },
  dependency: { label: 'Dependency', icon: 'git-network-outline', system: true },
  time_tracking: { label: 'Time tracking', icon: 'stopwatch-outline', system: true },
  approval: { label: 'Approval', icon: 'shield-checkmark-outline', system: true },
  sprint: { label: 'Sprint', icon: 'rocket-outline', system: true },
  item_type: { label: 'Item type', icon: 'shapes-outline', system: true },
};

/**
 * Built-in columns: which todos field they show, and which existing endpoint changes it. `edit` is how the
 * client changes it: PUT /todos/:id with `field`, POST /todos/:id/status, POST /todos/:id/assign, or
 * read-only.
 */
const SYSTEM_COLUMNS = {
  status: { kind: 'status', title: 'Status', field: 'status', edit: 'status', width: 150 },
  person: { kind: 'person', title: 'Owner', field: 'assignee_id', edit: 'assign', width: 110 },
  date: { kind: 'date', title: 'Due date', field: 'due_date', edit: 'put', width: 130 },
  deadline: { kind: 'date', title: 'Deadline', field: 'deadline_date', edit: 'put', width: 130 },
  timeline: { kind: 'timeline', title: 'Timeline', field: ['start_date', 'due_date'], edit: 'put', width: 180 },
  priority: { kind: 'priority', title: 'Priority', field: 'priority', edit: 'put', width: 120 },
  estimate: { kind: 'numbers', title: 'Estimate', field: 'duration_minutes', edit: 'put', width: 110, settings: { unit: 'min' } },
  labels: { kind: 'tags', title: 'Labels', field: 'labels', edit: 'put', width: 160 },
  points: { kind: 'numbers', title: 'Story points', field: 'story_points', edit: 'workspace', width: 110 },
  sprint: { kind: 'sprint', title: 'Sprint', field: 'sprint_id', edit: 'workspace', width: 140 },
  item_type: { kind: 'item_type', title: 'Type', field: 'item_type', edit: 'workspace', width: 110 },
  dependency: { kind: 'dependency', title: 'Dependent On', field: 'depends_on', edit: 'depends', width: 170 },
  time_tracking: { kind: 'time_tracking', title: 'Time tracking', field: null, edit: 'timer', width: 140 },
  approval: { kind: 'approval', title: 'Approval', field: 'status', edit: 'approve', width: 130 },
  item_id: { kind: 'auto_number', title: 'Item ID', field: 'id', edit: null, width: 90 },
  created: { kind: 'creation_log', title: 'Created', field: 'created_at', edit: null, width: 160 },
  updated: { kind: 'last_updated', title: 'Last updated', field: 'updated_at', edit: null, width: 160 },
};

// A new board shows only what most work needs (simplicity rule, F-DSN-05); the rest is one click away.
const DEFAULT_COLUMNS = ['person', 'status', 'date', 'dependency'];
// Plain columns every new board also gets (after the built-in ones above): { kind, title, width }.
const DEFAULT_EXTRA_COLUMNS = [{ kind: 'long_text', title: 'Notes', width: 160 }, { kind: 'files', title: 'Files', width: 140 }];

const DEFAULT_STATUS_LABELS = [
  { label: 'Not started', color: 'grey', maps_to: 'todo' },
  { label: 'Working on it', color: 'orange', maps_to: 'in_progress' },
  { label: 'Stuck', color: 'red', maps_to: 'blocked' },
  { label: 'In review', color: 'blue', maps_to: 'in_review' },
  { label: 'On hold', color: 'purple', maps_to: 'on_hold' },
  { label: 'Done', color: 'green', maps_to: 'done' },
];

const DEFAULT_VIEWS = [
  { kind: 'table', name: 'Main table', settings: {} },
  { kind: 'kanban', name: 'Kanban', settings: { group_by: 'status' } },
];

const AI_ACTIONS = ['summarize', 'categorize', 'extract', 'translate', 'sentiment', 'reply', 'custom'];

const VIEW_KINDS = ['table', 'kanban', 'calendar', 'timeline', 'gantt', 'chart', 'workload', 'map', 'form', 'gallery', 'summary', 'activity'];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const HOUR_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+?[0-9 ()-]{5,20}$/;

function validDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

const fail = (error) => ({ error });
const ok = (value) => ({ value });
const trimText = (v, max) => String(v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, max);

/**
 * Validate and normalise a custom cell value. `null` (or '') clears the cell. Returns { value } or { error }.
 * `ctx` may carry { labelIds, optionIds } (what exists on this column) and { userIds } (who may be picked).
 */
function cleanValue(kind, raw, settings = {}, ctx = {}) {
  const def = KINDS[kind];
  if (!def) return fail('Unknown column type');
  if (def.computed || def.system) return fail('This column fills itself');
  if (raw === null || raw === undefined || raw === '') return ok(null);

  switch (def.value) {
    case 'label': {
      const id = Number(raw?.label_id ?? raw);
      if (!Number.isInteger(id) || (ctx.labelIds && !ctx.labelIds.includes(id))) return fail('Pick one of this column\'s labels');
      return ok({ label_id: id });
    }
    case 'people': {
      const ids = [...new Set((Array.isArray(raw) ? raw : [raw]).map(Number))].filter((n) => Number.isInteger(n) && n > 0);
      if (ids.length > 25) return fail('Up to 25 people');
      if (ctx.userIds && ids.some((id) => !ctx.userIds.includes(id))) return fail('Someone picked cannot see this board');
      return ok(ids.length ? ids : null);
    }
    case 'date': {
      const date = typeof raw === 'object' ? raw.date : raw;
      const time = typeof raw === 'object' ? raw.time : undefined;
      if (!validDate(date)) return fail('Use a date like 2026-11-05');
      if (time !== undefined && time !== null && !HOUR_RE.test(time)) return fail('Use a time like 14:30');
      return ok(time ? { date, time } : { date });
    }
    case 'range': {
      const { start, end } = raw || {};
      if (!validDate(start) || !validDate(end)) return fail('Pick a start and an end date');
      if (end < start) return fail('The end is before the start');
      return ok({ start, end });
    }
    case 'options': {
      const ids = [...new Set((Array.isArray(raw) ? raw : [raw]).map(String))];
      const known = (settings.options || []).map((o) => String(o.id));
      if (ids.some((id) => !known.includes(id))) return fail('Pick one of this column\'s options');
      if (!settings.multiple && ids.length > 1) return fail('Pick one option');
      return ok(ids.length ? ids : null);
    }
    case 'tags': {
      const tags = [...new Set((Array.isArray(raw) ? raw : String(raw).split(',')).map((t) => trimText(t, 40)).filter(Boolean))];
      if (tags.length > 20) return fail('Up to 20 tags');
      return ok(tags.length ? tags : null);
    }
    case 'text': {
      const s = trimText(raw, 255);
      return ok(s || null);
    }
    case 'long_text': {
      const s = String(raw).slice(0, 5000);
      return ok(s.trim() ? s : null);
    }
    case 'number': {
      const n = typeof raw === 'number' ? raw : Number(String(raw).replace(/,/g, ''));
      if (!Number.isFinite(n)) return fail('Enter a number');
      if (Math.abs(n) > 1e15) return fail('That number is too large');
      const decimals = Number.isInteger(settings.decimals) ? Math.min(Math.max(settings.decimals, 0), 6) : 6;
      return ok(Number(n.toFixed(decimals)));
    }
    case 'boolean':
      return ok(raw === true || raw === 'true' || raw === 1 ? true : null);
    case 'link': {
      const url = trimText(typeof raw === 'object' ? raw.url : raw, 2000);
      const text = typeof raw === 'object' && raw.text ? trimText(raw.text, 120) : null;
      if (!/^(https?:\/\/|mailto:)/i.test(url)) return fail('Links start with http://, https:// or mailto:');
      return ok(text ? { url, text } : { url });
    }
    case 'email': {
      const s = trimText(raw, 254).toLowerCase();
      return EMAIL_RE.test(s) ? ok(s) : fail('That is not an email address');
    }
    case 'phone': {
      const s = trimText(raw, 20);
      return PHONE_RE.test(s) ? ok(s) : fail('That is not a phone number');
    }
    case 'rating': {
      const max = Number.isInteger(settings.max) ? Math.min(Math.max(settings.max, 1), 10) : 5;
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 0 || n > max) return fail(`Rate from 0 to ${max}`);
      return ok(n === 0 ? null : n);
    }
    case 'percent': {
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0 || n > 100) return fail('Use 0 to 100');
      return ok(Math.round(n));
    }
    case 'hour':
      return HOUR_RE.test(String(raw)) ? ok(String(raw)) : fail('Use a time like 14:30');
    case 'week': {
      if (!validDate(raw)) return fail('Pick a week');
      const [y, m, d] = raw.split('-').map(Number);
      const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
      const monday = new Date(Date.UTC(y, m - 1, d - ((day + 6) % 7)));
      return ok(monday.toISOString().slice(0, 10));
    }
    case 'location': {
      const address = trimText(typeof raw === 'object' ? raw.address || '' : raw, 300);
      const lat = typeof raw === 'object' && raw.lat !== undefined ? Number(raw.lat) : null;
      const lng = typeof raw === 'object' && raw.lng !== undefined ? Number(raw.lng) : null;
      if ((lat !== null && !(lat >= -90 && lat <= 90)) || (lng !== null && !(lng >= -180 && lng <= 180))) return fail('That place is off the map');
      if (!address && lat === null) return ok(null);
      return ok({ address, ...(lat !== null && lng !== null ? { lat, lng } : {}) });
    }
    case 'country': {
      const code = String(raw).trim().toUpperCase();
      return /^[A-Z]{2}$/.test(code) ? ok(code) : fail('Use a two-letter country code');
    }
    case 'color':
      return COLOR_NAMES.includes(raw) ? ok(raw) : fail('Pick a colour from the palette');
    case 'timezone': {
      try {
        new Intl.DateTimeFormat('en', { timeZone: String(raw) });
        return ok(String(raw));
      } catch {
        return fail('Unknown time zone');
      }
    }
    case 'files':
    case 'items':
    case 'voters': {
      const ids = [...new Set((Array.isArray(raw) ? raw : [raw]).map(Number))].filter((n) => Number.isInteger(n) && n > 0);
      if (ids.length > 50) return fail('Up to 50');
      return ok(ids.length ? ids : null);
    }
    default:
      return fail('Unknown column type');
  }
}

/** Settings a column of this kind may carry, cleaned. Unknown keys are dropped. */
function cleanSettings(kind, raw = {}) {
  const s = {};
  if (!raw || typeof raw !== 'object') return s;
  if (kind === 'numbers') {
    if (raw.unit) s.unit = trimText(raw.unit, 12);
    if (Number.isInteger(raw.decimals)) s.decimals = Math.min(Math.max(raw.decimals, 0), 6);
    if (['left', 'right'].includes(raw.unit_side)) s.unit_side = raw.unit_side;
    if (['sum', 'average', 'median', 'min', 'max', 'count', 'none'].includes(raw.summary)) s.summary = raw.summary;
  }
  if (kind === 'dropdown') {
    s.multiple = !!raw.multiple;
    const seen = new Set();
    s.options = (Array.isArray(raw.options) ? raw.options : []).slice(0, 200).map((o, i) => {
      let id = trimText(o.id ?? `o${i + 1}`, 20) || `o${i + 1}`;
      while (seen.has(id)) id = `${id}_`;
      seen.add(id);
      return { id, label: trimText(o.label || '', 60) || `Option ${i + 1}`, color: COLOR_NAMES.includes(o.color) ? o.color : 'grey' };
    });
  }
  if (kind === 'rating' && Number.isInteger(raw.max)) s.max = Math.min(Math.max(raw.max, 1), 10);
  if (kind === 'date' && raw.with_time !== undefined) s.with_time = !!raw.with_time;
  if (kind === 'progress' && raw.from_subitems !== undefined) s.from_subitems = !!raw.from_subitems;
  if (kind === 'world_clock' && raw.timezone) s.timezone = trimText(raw.timezone, 60);
  if (kind === 'formula' && raw.expression !== undefined) s.expression = String(raw.expression).slice(0, 2000);
  if (kind === 'mirror') {
    if (Number.isInteger(raw.relation_column_id)) s.relation_column_id = raw.relation_column_id;
    if (Number.isInteger(raw.target_column_id)) s.target_column_id = raw.target_column_id;
  }
  if (kind === 'board_relation' && Number.isInteger(raw.board_id)) s.board_id = raw.board_id;
  if (kind === 'button') {
    if (raw.label) s.label = trimText(raw.label, 40);
    if (Number.isInteger(raw.automation_task_id)) s.automation_task_id = raw.automation_task_id;
  }
  if (raw.show_on_mobile !== undefined) s.show_on_mobile = !!raw.show_on_mobile;
  // Who may see / change this column (F-MORE-03), and whether an item needs it before it is Done (F-MORE-04).
  if (['everyone', 'managers'].includes(raw.view)) s.view = raw.view;
  if (['everyone', 'managers'].includes(raw.edit)) s.edit = raw.edit;
  if (raw.required !== undefined) s.required = !!raw.required;
  if (kind === 'ai') {
    if (AI_ACTIONS.includes(raw.action)) s.action = raw.action;
    if (Array.isArray(raw.source_column_ids)) s.source_column_ids = raw.source_column_ids.filter(Number.isInteger).slice(0, 10);
    if (raw.instruction !== undefined) s.instruction = trimText(raw.instruction, 500);
  }
  return s;
}

module.exports = {
  PALETTE,
  COLOR_NAMES,
  STATUS_KEYS,
  KINDS,
  SYSTEM_COLUMNS,
  DEFAULT_COLUMNS, DEFAULT_EXTRA_COLUMNS,
  DEFAULT_STATUS_LABELS,
  DEFAULT_VIEWS,
  VIEW_KINDS,
  AI_ACTIONS,
  cleanValue,
  cleanSettings,
  validDate,
};
