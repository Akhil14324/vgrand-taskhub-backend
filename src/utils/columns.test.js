const test = require('node:test');
const assert = require('node:assert');
const {
  KINDS, SYSTEM_COLUMNS, DEFAULT_COLUMNS, DEFAULT_STATUS_LABELS, PALETTE, STATUS_KEYS, cleanValue, cleanSettings, validDate,
} = require('./columns');

test('every built-in column uses a known type, and defaults are built in', () => {
  for (const [key, col] of Object.entries(SYSTEM_COLUMNS)) assert.ok(KINDS[col.kind], key);
  for (const key of DEFAULT_COLUMNS) assert.ok(SYSTEM_COLUMNS[key], key);
});

test('default status labels cover every stored status once, in palette colours', () => {
  assert.deepStrictEqual(DEFAULT_STATUS_LABELS.map((l) => l.maps_to).sort(), [...STATUS_KEYS].sort());
  for (const l of DEFAULT_STATUS_LABELS) assert.ok(PALETTE[l.color], l.color);
});

test('empty input clears any cell', () => {
  for (const kind of ['text', 'numbers', 'date', 'dropdown', 'checkbox', 'link']) {
    assert.deepStrictEqual(cleanValue(kind, null), { value: null });
    assert.deepStrictEqual(cleanValue(kind, ''), { value: null });
  }
});

test('computed and built-in-only types cannot be written', () => {
  assert.ok(cleanValue('formula', 1).error);
  assert.ok(cleanValue('priority', 1).error);
  assert.ok(cleanValue('nope', 1).error);
});

test('dates are real calendar dates', () => {
  assert.strictEqual(validDate('2026-02-29'), false);
  assert.strictEqual(validDate('2028-02-29'), true);
  assert.deepStrictEqual(cleanValue('date', '2026-11-05'), { value: { date: '2026-11-05' } });
  assert.deepStrictEqual(cleanValue('date', { date: '2026-11-05', time: '09:30' }), { value: { date: '2026-11-05', time: '09:30' } });
  assert.ok(cleanValue('date', '05/11/2026').error);
  assert.ok(cleanValue('timeline', { start: '2026-11-10', end: '2026-11-01' }).error);
  assert.deepStrictEqual(cleanValue('timeline', { start: '2026-11-01', end: '2026-11-10' }), { value: { start: '2026-11-01', end: '2026-11-10' } });
});

test('numbers accept thousands separators and respect decimals', () => {
  assert.deepStrictEqual(cleanValue('numbers', '1,25,000'), { value: 125000 });
  assert.deepStrictEqual(cleanValue('numbers', 2.4567, { decimals: 2 }), { value: 2.46 });
  assert.ok(cleanValue('numbers', 'abc').error);
});

test('dropdown values must be existing options; single unless multiple', () => {
  const settings = cleanSettings('dropdown', { options: [{ id: 'a', label: 'Cash' }, { id: 'b', label: 'UPI', color: 'blue' }] });
  assert.deepStrictEqual(cleanValue('dropdown', 'a', settings), { value: ['a'] });
  assert.ok(cleanValue('dropdown', ['a', 'b'], settings).error);
  assert.deepStrictEqual(cleanValue('dropdown', ['a', 'b'], { ...settings, multiple: true }), { value: ['a', 'b'] });
  assert.ok(cleanValue('dropdown', 'z', settings).error);
  assert.strictEqual(settings.options[0].color, 'grey');
});

test('status labels and people are checked against what exists', () => {
  assert.deepStrictEqual(cleanValue('status', 7, {}, { labelIds: [7, 8] }), { value: { label_id: 7 } });
  assert.ok(cleanValue('status', 9, {}, { labelIds: [7, 8] }).error);
  assert.deepStrictEqual(cleanValue('person', [3, 3, 4], {}, { userIds: [3, 4] }), { value: [3, 4] });
  assert.ok(cleanValue('person', [5], {}, { userIds: [3, 4] }).error);
});

test('links, emails and phones are validated', () => {
  assert.deepStrictEqual(cleanValue('link', 'https://vgrand.in'), { value: { url: 'https://vgrand.in' } });
  assert.ok(cleanValue('link', 'javascript:alert(1)').error);
  assert.deepStrictEqual(cleanValue('email', ' Akhil@Vgrand.IN '), { value: 'akhil@vgrand.in' });
  assert.ok(cleanValue('email', 'akhil@').error);
  assert.deepStrictEqual(cleanValue('phone', '+91 98480 22338'), { value: '+91 98480 22338' });
});

test('week snaps to its Monday; rating and progress stay in range', () => {
  assert.deepStrictEqual(cleanValue('week', '2026-11-05'), { value: '2026-11-02' });
  assert.deepStrictEqual(cleanValue('rating', 4), { value: 4 });
  assert.ok(cleanValue('rating', 6).error);
  assert.deepStrictEqual(cleanValue('progress', 62.4), { value: 62 });
  assert.ok(cleanValue('progress', 120).error);
});

test('tags are trimmed and unique; colour must be in the palette', () => {
  assert.deepStrictEqual(cleanValue('tags', 'urgent, site , urgent'), { value: ['urgent', 'site'] });
  assert.deepStrictEqual(cleanValue('color', 'berry'), { value: 'berry' });
  assert.ok(cleanValue('color', '#ff0000').error);
});
