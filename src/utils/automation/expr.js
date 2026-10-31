/**
 * The small, safe language automations use for conditions and calculations. No JavaScript is ever
 * evaluated: this is a hand-written tokenizer + parser over a fixed set of operators and functions, with
 * limits on input size, depth and regular expressions, so a person's automation cannot hurt the server.
 *
 *   text:       "%todo_title" contains "invoice"   ->  contains(%todo_title, "invoice")
 *   numbers:    %count * 2 + 1
 *   compare:    == != < > <= >=   and   ~  (matches a regular expression)
 *   logic:      && || !
 *   variables:  %name, %list(2) (1-based item), %list(#) (how many)
 */

const MAX_EXPR = 1000;
const MAX_TEXT = 20000;
const MAX_DEPTH = 40;

class ExprError extends Error {}

// ---- variables inside plain text ------------------------------------------------------------------

const VAR_IN_TEXT = /%([A-Za-z_][A-Za-z0-9_]*)(?:\((#|\d+)\))?/g;

const asText = (v) => {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.map(asText).join(',');
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Math.round(v * 1e6) / 1e6);
  return String(v);
};

/** Value of `%name`, `%name(3)` or `%name(#)` against a lookup function; undefined if unknown. */
function readVar(lookup, name, index) {
  const value = lookup(name);
  if (value === undefined) return undefined;
  if (index === undefined) return value;
  const list = Array.isArray(value) ? value : (value === '' ? [] : String(value).split(','));
  if (index === '#') return list.length;
  const item = list[Number(index) - 1];
  return item === undefined ? '' : item;
}

/** Replace every known %variable in a text by its value; unknown ones stay as they are. */
function interpolate(text, lookup) {
  if (typeof text !== 'string' || !text.includes('%')) return text;
  return text.slice(0, MAX_TEXT).replace(VAR_IN_TEXT, (whole, name, index) => {
    const v = readVar(lookup, name, index);
    return v === undefined ? whole : asText(v);
  });
}

// ---- tokenizer ------------------------------------------------------------------------------------

function tokenize(src) {
  if (src.length > MAX_EXPR) throw new ExprError('That expression is too long');
  const out = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i += 1; continue; }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] || ''))) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j += 1;
      out.push({ t: 'num', v: Number(src.slice(i, j)) });
      i = j; continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      let s = '';
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\' && j + 1 < src.length) { s += ({ n: '\n', t: '\t' })[src[j + 1]] ?? src[j + 1]; j += 2; } else { s += src[j]; j += 1; }
      }
      if (j >= src.length) throw new ExprError('A quote was never closed');
      out.push({ t: 'str', v: s });
      i = j + 1; continue;
    }
    if (c === '%') {
      // %name is a variable; a % followed by anything else (a space, a digit) is the remainder operator.
      const m = /^%([A-Za-z_][A-Za-z0-9_]*)(?:\((#|\d+)\))?/.exec(src.slice(i));
      if (m) {
        out.push({ t: 'var', name: m[1], index: m[2] });
        i += m[0].length; continue;
      }
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j += 1;
      out.push({ t: 'id', v: src.slice(i, j) });
      i = j; continue;
    }
    const two = src.slice(i, i + 2);
    if (['==', '!=', '<=', '>=', '&&', '||'].includes(two)) { out.push({ t: 'op', v: two }); i += 2; continue; }
    if ('+-*/%<>!~(),[]'.includes(c)) { out.push({ t: 'op', v: c }); i += 1; continue; }
    throw new ExprError(`Unexpected "${c}"`);
  }
  return out;
}

// ---- values ---------------------------------------------------------------------------------------

const isNumeric = (v) => (typeof v === 'number' && Number.isFinite(v))
  || (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)));
const toNum = (v) => (isNumeric(v) ? Number(v) : NaN);
const truthy = (v) => {
  if (typeof v === 'string') return v !== '' && v.toLowerCase() !== 'false' && v !== '0';
  if (Array.isArray(v)) return v.length > 0;
  return !!v;
};

const REGEX_RISK = /(\([^)]*[+*][^)]*\)\s*[+*{])|(\.\*\s*\.\*)/;
function safeRegex(pattern, flags = 'i') {
  const p = String(pattern);
  if (p.length > 200) throw new ExprError('That pattern is too long');
  if (REGEX_RISK.test(p)) throw new ExprError('That pattern could take too long to check');
  try { return new RegExp(p, flags); } catch { throw new ExprError('That is not a valid pattern'); }
}

function compare(op, a, b) {
  if (isNumeric(a) && isNumeric(b)) {
    const x = toNum(a); const y = toNum(b);
    return { '==': x === y, '!=': x !== y, '<': x < y, '>': x > y, '<=': x <= y, '>=': x >= y }[op];
  }
  const x = asText(a).toLowerCase(); const y = asText(b).toLowerCase();
  return { '==': x === y, '!=': x !== y, '<': x < y, '>': x > y, '<=': x <= y, '>=': x >= y }[op];
}

const FUNCTIONS = Object.assign(Object.create(null), {
  len: (v) => (Array.isArray(v) ? v.length : asText(v).length),
  upper: (v) => asText(v).toUpperCase(),
  lower: (v) => asText(v).toLowerCase(),
  trim: (v) => asText(v).trim(),
  replace: (s, a, b) => asText(s).split(asText(a)).join(asText(b)),
  contains: (s, part) => (Array.isArray(s) ? s.map((x) => asText(x).toLowerCase()).includes(asText(part).toLowerCase()) : asText(s).toLowerCase().includes(asText(part).toLowerCase())),
  startsWith: (s, p) => asText(s).toLowerCase().startsWith(asText(p).toLowerCase()),
  endsWith: (s, p) => asText(s).toLowerCase().endsWith(asText(p).toLowerCase()),
  substr: (s, start, length) => asText(s).substr(Math.max(0, toNum(start) - 1 || 0), length === undefined ? undefined : Math.max(0, toNum(length) || 0)),
  split: (s, sep = ',') => (asText(s) === '' ? [] : asText(s).split(asText(sep))),
  join: (list, sep = ',') => (Array.isArray(list) ? list : asText(list).split(',')).map(asText).join(asText(sep)),
  indexOf: (s, part) => asText(s).toLowerCase().indexOf(asText(part).toLowerCase()) + 1,
  round: (n, places = 0) => { const f = 10 ** Math.min(6, Math.max(0, toNum(places) || 0)); return Math.round(toNum(n) * f) / f; },
  floor: (n) => Math.floor(toNum(n)),
  ceil: (n) => Math.ceil(toNum(n)),
  abs: (n) => Math.abs(toNum(n)),
  min: (...a) => Math.min(...a.map(toNum)),
  max: (...a) => Math.max(...a.map(toNum)),
  int: (v) => Math.trunc(toNum(v)) || 0,
  num: (v) => (isNumeric(v) ? Number(v) : 0),
  str: (v) => asText(v),
  isEmpty: (v) => (Array.isArray(v) ? v.length === 0 : asText(v).trim() === ''),
  isNumber: (v) => isNumeric(v),
  regex: (s, pattern) => safeRegex(pattern).test(asText(s).slice(0, 5000)),
  regexGet: (s, pattern, group = 0) => {
    const m = safeRegex(pattern).exec(asText(s).slice(0, 5000));
    return m ? (m[Math.max(0, toNum(group) || 0)] ?? '') : '';
  },
  first: (list) => (Array.isArray(list) ? list : asText(list).split(','))[0] ?? '',
  last: (list) => { const l = Array.isArray(list) ? list : asText(list).split(','); return l[l.length - 1] ?? ''; },
  item: (list, n) => (Array.isArray(list) ? list : asText(list).split(','))[toNum(n) - 1] ?? '',
  count: (list) => (Array.isArray(list) ? list.length : (asText(list) === '' ? 0 : asText(list).split(',').length)),
  if: (cond, a, b = '') => (truthy(cond) ? a : b),
  default: (v, fallback) => (truthy(v) ? v : fallback),
  rand: (a = 0, b = 100) => { const lo = toNum(a); const hi = toNum(b); return lo + Math.floor(Math.random() * (hi - lo + 1)); },
  now: () => Math.floor(Date.now() / 1000),
  pad: (v, width, ch = '0') => asText(v).padStart(toNum(width) || 0, asText(ch)[0] || '0'),
  not: (v) => !truthy(v),
  // Dates as 'YYYY-MM-DD' (board formulas): today in the app's time zone, whole days from a to b, a plus n days.
  today: () => dayInZone(new Date()),
  days: (a, b) => { const x = ymdToUtc(a); const y = ymdToUtc(b); return x === null || y === null ? '' : Math.round((y - x) / 86400000); },
  addDays: (d, n) => { const x = ymdToUtc(d); return x === null ? '' : new Date(x + (toNum(n) || 0) * 86400000).toISOString().slice(0, 10); },
});
const FUNCTION_ARITY = Object.assign(Object.create(null), { rand: [0, 2], now: [0, 0], substr: [2, 3], if: [2, 3], today: [0, 0], days: [2, 2], addDays: [2, 2] });

function ymdToUtc(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(asText(v));
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}
function dayInZone(date) {
  const zone = process.env.APP_TIMEZONE || 'Asia/Kolkata';
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

// ---- parser / evaluator (evaluates while parsing) -------------------------------------------------

function evaluate(src, lookup = () => undefined) {
  const tokens = tokenize(String(src ?? ''));
  let pos = 0;
  let depth = 0;
  const peek = () => tokens[pos];
  const take = () => { pos += 1; return tokens[pos - 1]; };
  const isOp = (v) => peek() && peek().t === 'op' && peek().v === v;

  function enter() { depth += 1; if (depth > MAX_DEPTH) throw new ExprError('That expression is nested too deeply'); }
  function leave() { depth -= 1; }

  function parseOr() {
    let left = parseAnd();
    while (isOp('||')) { take(); const right = parseAnd(); left = truthy(left) || truthy(right); }
    return left;
  }
  function parseAnd() {
    let left = parseCmp();
    while (isOp('&&')) { take(); const right = parseCmp(); left = truthy(left) && truthy(right); }
    return left;
  }
  function parseCmp() {
    let left = parseAdd();
    for (;;) {
      const t = peek();
      if (t && t.t === 'op' && ['==', '!=', '<', '>', '<=', '>='].includes(t.v)) {
        take(); left = compare(t.v, left, parseAdd());
      } else if (t && t.t === 'op' && t.v === '~') {
        take(); left = safeRegex(asText(parseAdd())).test(asText(left).slice(0, 5000));
      } else return left;
    }
  }
  function parseAdd() {
    let left = parseMul();
    for (;;) {
      const t = peek();
      if (t && t.t === 'op' && (t.v === '+' || t.v === '-')) {
        take(); const right = parseMul();
        if (t.v === '+') left = (isNumeric(left) && isNumeric(right)) ? toNum(left) + toNum(right) : asText(left) + asText(right);
        else left = toNum(left) - toNum(right);
      } else return left;
    }
  }
  function parseMul() {
    let left = parseUnary();
    for (;;) {
      const t = peek();
      if (t && t.t === 'op' && (t.v === '*' || t.v === '/' || t.v === '%')) {
        take(); const right = toNum(parseUnary()); const l = toNum(left);
        if (t.v === '*') left = l * right;
        else if (right === 0) throw new ExprError('Cannot divide by zero');
        else left = t.v === '/' ? l / right : l % right;
      } else return left;
    }
  }
  function parseUnary() {
    if (isOp('!')) { take(); enter(); const v = !truthy(parseUnary()); leave(); return v; }
    if (isOp('-')) { take(); enter(); const v = -toNum(parseUnary()); leave(); return v; }
    return parsePrimary();
  }
  function parsePrimary() {
    const t = take();
    if (!t) throw new ExprError('The expression ends too early');
    if (t.t === 'num' || t.t === 'str') return t.v;
    if (t.t === 'var') {
      const v = readVar(lookup, t.name, t.index);
      return v === undefined ? '' : v;
    }
    if (t.t === 'op' && t.v === '(') {
      enter(); const v = parseOr(); leave();
      if (!isOp(')')) throw new ExprError('A bracket was never closed');
      take(); return v;
    }
    if (t.t === 'op' && t.v === '[') {
      const items = [];
      if (!isOp(']')) { do { enter(); items.push(parseOr()); leave(); } while (isOp(',') && take()); }
      if (!isOp(']')) throw new ExprError('A list was never closed');
      take(); return items;
    }
    if (t.t === 'id') {
      const word = t.v.toLowerCase();
      if (!isOp('(')) {
        if (word === 'true') return true;
        if (word === 'false') return false;
        if (word === 'null' || word === 'none') return '';
        throw new ExprError(`"${t.v}" is not a known word. Put text in quotes, or use % for a variable`);
      }
      take();
      const fn = FUNCTIONS[t.v] || FUNCTIONS[Object.keys(FUNCTIONS).find((k) => k.toLowerCase() === word)];
      if (!fn) throw new ExprError(`There is no function called ${t.v}`);
      const args = [];
      if (!isOp(')')) { do { enter(); args.push(parseOr()); leave(); } while (isOp(',') && take()); }
      if (!isOp(')')) throw new ExprError('A bracket was never closed');
      take();
      const [lo, hi] = FUNCTION_ARITY[t.v] || [1, 4];
      if (args.length < lo || args.length > hi) throw new ExprError(`${t.v} takes ${lo === hi ? lo : `${lo} to ${hi}`} values`);
      return fn(...args);
    }
    throw new ExprError(`Unexpected "${t.v}"`);
  }

  const result = parseOr();
  if (pos < tokens.length) throw new ExprError(`Unexpected "${tokens[pos].v ?? tokens[pos].name}"`);
  return result;
}

/** A condition: true/false, with the same rules as evaluate(). A blank condition counts as true. */
function evalCondition(src, lookup) {
  if (src === undefined || src === null || String(src).trim() === '') return true;
  return truthy(evaluate(src, lookup));
}

const CMP_OPS = Object.assign(Object.create(null), {
  eq: { label: 'is', needs: 2 },
  ne: { label: 'is not', needs: 2 },
  gt: { label: 'is more than', needs: 2 },
  lt: { label: 'is less than', needs: 2 },
  ge: { label: 'is at least', needs: 2 },
  le: { label: 'is at most', needs: 2 },
  contains: { label: 'contains', needs: 2 },
  not_contains: { label: 'does not contain', needs: 2 },
  starts: { label: 'starts with', needs: 2 },
  ends: { label: 'ends with', needs: 2 },
  matches: { label: 'matches pattern', needs: 2 },
  empty: { label: 'is empty', needs: 1 },
  not_empty: { label: 'is not empty', needs: 1 },
});

/** The friendly three-box condition (left, operator, right) -> a boolean. Values are interpolated first. */
function evalComparison({ left = '', op = 'eq', right = '' }, lookup) {
  const l = interpolate(String(left), lookup);
  const r = interpolate(String(right), lookup);
  switch (op) {
    case 'eq': return compare('==', l, r);
    case 'ne': return compare('!=', l, r);
    case 'gt': return compare('>', l, r);
    case 'lt': return compare('<', l, r);
    case 'ge': return compare('>=', l, r);
    case 'le': return compare('<=', l, r);
    case 'contains': return FUNCTIONS.contains(l, r);
    case 'not_contains': return !FUNCTIONS.contains(l, r);
    case 'starts': return FUNCTIONS.startsWith(l, r);
    case 'ends': return FUNCTIONS.endsWith(l, r);
    case 'matches': return safeRegex(r).test(l.slice(0, 5000));
    case 'empty': return l.trim() === '';
    case 'not_empty': return l.trim() !== '';
    default: throw new ExprError('Unknown comparison');
  }
}

module.exports = {
  ExprError, interpolate, evaluate, evalCondition, evalComparison, asText, truthy, isNumeric, toNum, safeRegex, CMP_OPS, FUNCTIONS,
};
