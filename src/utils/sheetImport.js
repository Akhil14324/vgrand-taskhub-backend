/**
 * Turning spreadsheet text (pasted from Excel / Google Sheets, or read from .xlsx / .csv) into board values.
 * Pure (no database) and unit-tested in sheetImport.test.js. Every reader returns `undefined` when it cannot
 * read the text, so the caller can say which cell was left empty and why.
 */

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const pad = (n) => String(n).padStart(2, '0');

function realDay(y, m, d) {
  if (!(y >= 1900 && y <= 2200 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return undefined;
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCMonth() !== m - 1) return undefined;
  return `${y}-${pad(m)}-${pad(d)}`;
}

const fullYear = (y) => (y < 100 ? 2000 + y : y);
const monthOf = (word) => {
  const i = MONTHS.indexOf(String(word).slice(0, 3).toLowerCase());
  return i >= 0 ? i + 1 : 0;
};

/** Excel's day number (1900 system) -> 'YYYY-MM-DD'. 45966 = 2025-11-05. */
function excelSerialDay(n) {
  if (!(n > 0 && n < 2958466)) return undefined;
  const t = new Date(Date.UTC(1899, 11, 30) + Math.floor(n) * 86400000);
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/**
 * Text of a date cell -> 'YYYY-MM-DD'. Reads 2026-11-05, 05/11/2026 (day first, as in India; 11/25/2026 is
 * read month first because 25 cannot be a month), 5.11.26, 5 Nov 2026, 05-Nov-26, Nov 5, 2026, Thursday 5
 * November 2026, a time after the date, and Excel day numbers. `year` fills a missing year.
 */
function readDate(raw, { year, dayFirst = true } = {}) {
  if (raw === null || raw === undefined) return undefined;
  if (typeof raw === 'number') return raw > 20000 && raw < 80000 ? excelSerialDay(raw) : undefined;
  let s = String(raw).trim().toLowerCase().replace(/(\d)(st|nd|rd|th)\b/g, '$1');
  if (!s) return undefined;
  s = s.replace(/^(mon|tue|wed|thu|fri|sat|sun)[a-z]*,?\s+/, '');
  // Drop a time after the date (2026-11-05T10:00, 05/11/2026 14:30, 5 Nov 2026 2:30 pm).
  s = s.replace(/[t\s]+\d{1,2}:\d{2}(:\d{2}(\.\d+)?)?\s*(am|pm)?\s*(z|[+-]\d{2}:?\d{2})?$/, '').trim();
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s);
  if (m) return realDay(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/.exec(s);
  if (m) {
    const a = +m[1]; const b = +m[2]; const y = fullYear(+m[3]);
    if (a > 12) return realDay(y, b, a);
    if (b > 12) return realDay(y, a, b);
    return dayFirst ? realDay(y, b, a) : realDay(y, a, b);
  }
  m = /^(\d{1,2})[-/.](\d{1,2})$/.exec(s);
  if (m && year) {
    const a = +m[1]; const b = +m[2];
    return a > 12 || dayFirst ? realDay(year, b, a) : realDay(year, a, b);
  }
  // 5 Nov 2026, 5-Nov-26, 5 November
  m = /^(\d{1,2})[\s\-/.]+([a-z]{3,9})\.?[\s\-/.,]*(\d{2}|\d{4})?$/.exec(s);
  if (m && monthOf(m[2])) {
    const y = m[3] ? fullYear(+m[3]) : year;
    return y ? realDay(y, monthOf(m[2]), +m[1]) : undefined;
  }
  // Nov 5, 2026 / November 5 / Nov-05-2026
  m = /^([a-z]{3,9})\.?[\s\-/.]+(\d{1,2})[\s\-/.,]*(\d{2}|\d{4})?$/.exec(s);
  if (m && monthOf(m[1])) {
    const y = m[3] ? fullYear(+m[3]) : year;
    return y ? realDay(y, monthOf(m[1]), +m[2]) : undefined;
  }
  if (/^\d{5}(\.\d+)?$/.test(s)) return readDate(Number(s));
  return undefined;
}

/** "2026-11-01 - 2026-11-05", "1 Nov – 5 Nov 2026", "01/11/2026 to 05/11/2026" -> { start, end }. */
function readRange(raw, opts = {}) {
  const s = String(raw ?? '').trim();
  if (!s) return undefined;
  const parts = s.split(/\s+(?:-|–|—|to|till|until|→)\s+|\s*(?:–|—|→)\s*/i).filter(Boolean);
  if (parts.length === 1) {
    const d = readDate(parts[0], opts);
    return d ? { start: d, end: d } : undefined;
  }
  if (parts.length !== 2) return undefined;
  const end = readDate(parts[1], opts);
  if (!end) return undefined;
  const start = readDate(parts[0], { ...opts, year: opts.year || Number(end.slice(0, 4)) });
  if (!start) return undefined;
  return start <= end ? { start, end } : { start: end, end: start };
}

/** "₹ 1,25,000.50", "(300)", "12%", "1.2k" -> a number. */
function readNumber(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : undefined;
  let s = String(raw ?? '').trim();
  if (!s) return undefined;
  let sign = 1;
  if (/^\(.*\)$/.test(s)) { sign = -1; s = s.slice(1, -1); }
  s = s.replace(/[₹$€£¥\s]|rs\.?|inr|usd/gi, '').replace(/,/g, '').replace(/%$/, '');
  let mult = 1;
  const suf = /^(-?[\d.]+)\s*(k|l|lakh|lakhs|cr|crore|crores|m)$/i.exec(s);
  if (suf) {
    s = suf[1];
    mult = { k: 1e3, l: 1e5, lakh: 1e5, lakhs: 1e5, cr: 1e7, crore: 1e7, crores: 1e7, m: 1e6 }[suf[2].toLowerCase()];
  }
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s)) return undefined;
  return sign * Number(s) * mult;
}

const TRUE_WORDS = new Set(['yes', 'y', 'true', '1', 'x', '✓', '✔', 'done', 'checked', 'ok', 'tick', 'on']);
const FALSE_WORDS = new Set(['no', 'n', 'false', '0', '', 'off', 'unchecked', '-']);
/** A tick-box cell: true, null (empty) or undefined (unreadable). */
function readBool(raw) {
  if (raw === true || raw === false) return raw || null;
  const s = String(raw ?? '').trim().toLowerCase();
  if (TRUE_WORDS.has(s)) return true;
  if (FALSE_WORDS.has(s)) return null;
  return undefined;
}

/** Priority word -> 1 (urgent) .. 4 (none). */
function readPriority(raw) {
  const s = String(raw ?? '').trim().toLowerCase().replace(/^priority\s*/, '');
  if (!s) return undefined;
  if (/^(p?1|urgent|critical|highest|top|very high|asap)$/.test(s)) return 1;
  if (/^(p?2|high|important)$/.test(s)) return 2;
  if (/^(p?3|medium|normal|mid|moderate)$/.test(s)) return 3;
  if (/^(p?4|low|lowest|none|no)$/.test(s)) return 4;
  return undefined;
}

/** Which stage a status word means (for the built-in Status column). */
function stageOf(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s) return undefined;
  if (/not started|not yet|yet to|to ?do|pending|^new$|^open$|planned|backlog|^no$/.test(s)) return 'todo';
  if (/(^|\b)(done|complete|completed|finished|closed|resolved|delivered|paid|approved|yes)\b/.test(s)) return 'done';
  if (/stuck|block|issue|problem|delayed|overdue/.test(s)) return 'blocked';
  if (/review|check|verify|testing|qa\b/.test(s)) return 'in_review';
  if (/hold|pause|wait|later|parked|deferred/.test(s)) return 'on_hold';
  if (/progress|working|ongoing|started|doing|wip|active|running/.test(s)) return 'in_progress';
  return undefined;
}

/** "2h", "1h 30m", "90", "90 min", "1.5 hours", "2:30" -> minutes (1 .. 14400). */
function readMinutes(raw) {
  if (typeof raw === 'number') return raw >= 1 && raw <= 14400 ? Math.round(raw) : undefined;
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s) return undefined;
  let m = /^(\d{1,3}):([0-5]\d)$/.exec(s);
  let n;
  if (m) n = +m[1] * 60 + +m[2];
  else if (/^\d+(\.\d+)?$/.test(s)) n = Number(s);
  else {
    m = /^(?:(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hour|hours))?\s*(?:(\d+)\s*(?:m|min|mins|minute|minutes))?$/.exec(s);
    const d = /^(\d+(?:\.\d+)?)\s*(?:d|day|days)$/.exec(s);
    if (d) n = Number(d[1]) * 8 * 60;
    else if (m && (m[1] || m[2])) n = Number(m[1] || 0) * 60 + Number(m[2] || 0);
  }
  if (!(n >= 1 && n <= 14400)) return undefined;
  return Math.round(n);
}

/** "2:30 PM", "14:30", "9am" -> 'HH:MM'. */
function readHour(raw) {
  if (typeof raw === 'number' && raw >= 0 && raw < 1) {
    const mins = Math.round(raw * 1440);
    return `${pad(Math.floor(mins / 60) % 24)}:${pad(mins % 60)}`;
  }
  const m = /^(\d{1,2})(?::(\d{2}))?(?::\d{2})?\s*(am|pm|a\.m\.|p\.m\.)?$/i.exec(String(raw ?? '').trim());
  if (!m) return undefined;
  let h = +m[1]; const min = +(m[2] || 0);
  const ap = (m[3] || '').toLowerCase().replace(/\./g, '');
  if (!m[2] && !ap) return undefined;
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  return h <= 23 && min <= 59 ? `${pad(h)}:${pad(min)}` : undefined;
}

/** A cell that may hold several things: "a, b; c / d & e and f" (also new lines inside the cell). */
const splitList = (raw) => String(raw ?? '').split(/\s*(?:[,;\n/&|]|\s+and\s+)\s*/i).map((x) => x.trim()).filter(Boolean);

/**
 * Names / emails / usernames in a cell -> user ids. `people` = [{ id, name, email, username }]. A first name
 * counts only when exactly one person has it. Returns { ids, unknown: [text] }.
 */
function matchPeople(raw, people) {
  const ids = [];
  const unknown = [];
  const norm = (x) => String(x || '').trim().toLowerCase().replace(/\s+/g, ' ');
  for (const part of splitList(raw)) {
    const p = norm(part).replace(/^@/, '');
    let hit = people.filter((u) => norm(u.email) === p || norm(u.username) === p || norm(u.name) === p);
    if (!hit.length) hit = people.filter((u) => norm(u.name).split(' ')[0] === p);
    if (!hit.length) hit = people.filter((u) => norm(u.name).startsWith(`${p} `) || norm(u.email).split('@')[0] === p);
    if (hit.length === 1) { if (!ids.includes(hit[0].id)) ids.push(hit[0].id); } else unknown.push(part);
  }
  return { ids, unknown };
}

/** Text of a link cell: a bare "www.x.com" gets https:// in front. */
function readLink(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return undefined;
  if (/^(https?:\/\/|mailto:)/i.test(s)) return { url: s };
  if (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(s)) return { url: `https://${s}` };
  return undefined;
}

/** A phone cell: Excel turns 9876543210 into 9.87654E+09 when it is a number, so read numbers back. */
function readPhone(raw) {
  if (typeof raw === 'number') return String(Math.round(raw));
  const s = String(raw ?? '').trim();
  if (/^\d(\.\d+)?e\+\d+$/i.test(s)) return String(Math.round(Number(s)));
  return s.replace(/[^\d+()\- ]/g, '').trim() || undefined;
}

const PALETTE_CYCLE = ['blue', 'green', 'orange', 'purple', 'red', 'sky', 'yellow', 'pink', 'grass', 'indigo', 'brown', 'aquamarine', 'dark_blue', 'berry', 'dark_orange', 'lipstick', 'dark_green', 'dark_purple', 'black', 'grey'];
const STAGE_COLOR = { todo: 'grey', in_progress: 'orange', blocked: 'red', in_review: 'blue', on_hold: 'purple', done: 'green' };
/** A colour for the n-th new label; a label that reads like a stage gets that stage's colour. */
function colorFor(label, n) {
  const st = stageOf(label);
  return st ? STAGE_COLOR[st] : PALETTE_CYCLE[n % PALETTE_CYCLE.length];
}

/**
 * The raw text of a cell -> the value a custom column of `kind` stores (before cleanValue), or undefined when
 * it cannot be read. Status / dropdown / person cells are handled by the caller (they need the board's labels,
 * options and people).
 */
function readCustom(kind, raw, opts = {}) {
  const s = typeof raw === 'string' ? raw.trim() : raw;
  if (s === '' || s === null || s === undefined) return null;
  switch (kind) {
    case 'text': return String(s).replace(/\s*\n\s*/g, ' ');
    case 'long_text': case 'ai': return String(s);
    case 'numbers': return readNumber(s);
    case 'checkbox': return readBool(s);
    case 'date': { const d = readDate(s, opts); return d ? { date: d } : undefined; }
    case 'timeline': return readRange(s, opts);
    case 'week': return readDate(s, opts);
    case 'tags': return splitList(s).slice(0, 20);
    case 'link': return readLink(s);
    case 'email': return String(s).trim().toLowerCase().replace(/^mailto:/, '');
    case 'phone': return readPhone(s);
    case 'rating': {
      const stars = /^[★⭐*]+$/u.test(String(s)) ? [...String(s)].length : undefined;
      const n = stars ?? readNumber(String(s).replace(/\s*\/\s*\d+$/, ''));
      return Number.isInteger(n) ? n : undefined;
    }
    case 'progress': {
      const n = readNumber(s);
      if (n === undefined) return undefined;
      return n > 0 && n <= 1 && /\./.test(String(s)) && !/%/.test(String(s)) ? Math.round(n * 100) : Math.round(n);
    }
    case 'hour': return readHour(s);
    case 'location': return { address: String(s) };
    case 'country': return /^[a-z]{2}$/i.test(String(s)) ? String(s).toUpperCase() : undefined;
    case 'color': return String(s).trim().toLowerCase().replace(/\s+/g, '_');
    case 'world_clock': return String(s).trim();
    default: return undefined; // files, links to other boards, votes, computed columns: not from a sheet
  }
}

/** Column kinds a new column made from a sheet may have. */
const NEW_KINDS = ['text', 'long_text', 'numbers', 'date', 'timeline', 'status', 'dropdown', 'person', 'checkbox', 'email', 'phone', 'link', 'tags', 'progress', 'rating', 'hour'];

module.exports = {
  readDate, readRange, readNumber, readBool, readPriority, readMinutes, readHour, readLink, readPhone,
  stageOf, matchPeople, splitList, readCustom, colorFor, excelSerialDay, NEW_KINDS, STAGE_COLOR,
};
