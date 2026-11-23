// What a note may hold (pure, unit-tested). A text note is a small, safe subset of HTML written by the app's own
// editor (headings, bold / italic / underline, three text sizes, bullets, numbers, tick lists and a divider). A sheet note is
// a plain grid of cell texts. Anything else is cut away here, so nothing a browser could run is ever stored.

const TAGS = new Set(['h1', 'h2', 'h3', 'p', 'div', 'br', 'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'ul', 'ol', 'li', 'font', 'span', 'blockquote', 'hr']);
const VOID = new Set(['br', 'hr']);
const MAX_HTML = 200000;
const MAX_ROWS = 2000;
const MAX_COLS = 52;
const MAX_CELL = 2000;

/** The attributes one allowed tag may keep, written out again from scratch. */
function attrsFor(tag, raw) {
  const out = [];
  if (tag === 'font') {
    const m = /\bsize\s*=\s*["']?([1-7])\b/i.exec(raw);
    if (m) out.push(`size="${m[1]}"`);
  }
  if (tag === 'ul' && /\bdata-check\b/i.test(raw)) out.push('data-check="1"');
  if (tag === 'li' && /\bdata-done\s*=\s*["']?1/i.test(raw)) out.push('data-done="1"');
  return out.length ? ` ${out.join(' ')}` : '';
}

/** Editor HTML made safe: only the tags above, only those attributes, no scripts, styles, links or handlers. */
function sanitizeHtml(input) {
  let src = String(input ?? '').slice(0, MAX_HTML * 2);
  src = src.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style|iframe|object|embed|svg|math)\b[\s\S]*?<\/\1\s*>/gi, '');
  const tagRe = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g;
  let out = '';
  let last = 0;
  let m;
  const text = (t) => t.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  while ((m = tagRe.exec(src))) {
    out += text(src.slice(last, m.index));
    last = m.index + m[0].length;
    const tag = m[1].toLowerCase();
    if (!TAGS.has(tag)) continue;
    const closing = m[0][1] === '/';
    if (closing) { if (!VOID.has(tag)) out += `</${tag}>`; } else out += `<${tag}${attrsFor(tag, m[2])}>`;
  }
  out += text(src.slice(last));
  return out.slice(0, MAX_HTML);
}

/** The words of a text note without any markup (kept beside the HTML for search and the list preview). */
function plainText(html) {
  return String(html ?? '')
    .replace(/<\/(p|div|li|h1|h2|h3|blockquote)>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
    .slice(0, 50000);
}

/** A sheet made safe: { rows: [[text]], widths: [px] }. Rows are cut to the widest used width; empty tail rows go. */
function cleanSheet(raw) {
  const rowsIn = Array.isArray(raw?.rows) ? raw.rows.slice(0, MAX_ROWS) : [];
  let rows = rowsIn.map((r) => (Array.isArray(r) ? r.slice(0, MAX_COLS) : []).map((c) => (c === null || c === undefined ? '' : String(c).slice(0, MAX_CELL))));
  while (rows.length && rows[rows.length - 1].every((c) => c === '')) rows.pop();
  const cols = Math.max(1, ...rows.map((r) => { let n = r.length; while (n && r[n - 1] === '') n -= 1; return n; }));
  rows = rows.map((r) => Array.from({ length: cols }, (_, i) => r[i] ?? ''));
  const widths = (Array.isArray(raw?.widths) ? raw.widths : []).slice(0, cols).map((w) => Math.min(600, Math.max(50, Math.round(Number(w)) || 120)));
  return { rows, widths };
}

/** The words of a sheet, for search and the list preview. */
function sheetText(sheet) {
  return (sheet?.rows || []).map((r) => r.filter(Boolean).join('  ')).filter(Boolean).join('\n').slice(0, 50000);
}

module.exports = { sanitizeHtml, plainText, cleanSheet, sheetText, MAX_ROWS, MAX_COLS };
