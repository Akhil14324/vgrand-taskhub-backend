const test = require('node:test');
const assert = require('node:assert');
const S = require('./sheetImport');

test('dates as Excel and people type them', () => {
  const cases = {
    '2026-11-05': '2026-11-05',
    '2026-11-05T10:30:00Z': '2026-11-05',
    '05/11/2026': '2026-11-05', // day first (India)
    '5-11-26': '2026-11-05',
    '5.11.2026': '2026-11-05',
    '11/25/2026': '2026-11-25', // 25 cannot be a month
    '05/11/2026 14:30': '2026-11-05',
    '5 Nov 2026': '2026-11-05',
    '05-Nov-26': '2026-11-05',
    'Nov 5, 2026': '2026-11-05',
    'November 5th 2026': '2026-11-05',
    'Thursday, 5 November 2026': '2026-11-05',
    '45966': '2025-11-05',
  };
  for (const [raw, want] of Object.entries(cases)) assert.strictEqual(S.readDate(raw), want, raw);
  assert.strictEqual(S.readDate(45966), '2025-11-05');
  assert.strictEqual(S.readDate('5 Nov', { year: 2026 }), '2026-11-05');
  assert.strictEqual(S.readDate('31/02/2026'), undefined);
  assert.strictEqual(S.readDate('soon'), undefined);
  assert.strictEqual(S.readDate('05/11/2026', { dayFirst: false }), '2026-05-11');
});

test('ranges', () => {
  assert.deepStrictEqual(S.readRange('2026-11-01 - 2026-11-05'), { start: '2026-11-01', end: '2026-11-05' });
  assert.deepStrictEqual(S.readRange('1 Nov – 5 Nov 2026'), { start: '2026-11-01', end: '2026-11-05' });
  assert.deepStrictEqual(S.readRange('05/11/2026 to 01/11/2026'), { start: '2026-11-01', end: '2026-11-05' });
  assert.deepStrictEqual(S.readRange('05/11/2026'), { start: '2026-11-05', end: '2026-11-05' });
});

test('numbers, ticks, priority, minutes, hours', () => {
  assert.strictEqual(S.readNumber('₹ 1,25,000.50'), 125000.5);
  assert.strictEqual(S.readNumber('(300)'), -300);
  assert.strictEqual(S.readNumber('12%'), 12);
  assert.strictEqual(S.readNumber('2.5 lakh'), 250000);
  assert.strictEqual(S.readNumber('abc'), undefined);
  assert.strictEqual(S.readBool('Yes'), true);
  assert.strictEqual(S.readBool('✓'), true);
  assert.strictEqual(S.readBool('no'), null);
  assert.strictEqual(S.readBool('maybe'), undefined);
  assert.strictEqual(S.readPriority('High'), 2);
  assert.strictEqual(S.readPriority('P1'), 1);
  assert.strictEqual(S.readPriority('low'), 4);
  assert.strictEqual(S.readMinutes('1h 30m'), 90);
  assert.strictEqual(S.readMinutes('2:30'), 150);
  assert.strictEqual(S.readMinutes('45'), 45);
  assert.strictEqual(S.readMinutes('1.5 hours'), 90);
  assert.strictEqual(S.readHour('2:30 PM'), '14:30');
  assert.strictEqual(S.readHour('9am'), '09:00');
  assert.strictEqual(S.readHour(0.5), '12:00');
});

test('status words map to stages', () => {
  assert.strictEqual(S.stageOf('Done'), 'done');
  assert.strictEqual(S.stageOf('Completed'), 'done');
  assert.strictEqual(S.stageOf('Working on it'), 'in_progress');
  assert.strictEqual(S.stageOf('In Progress'), 'in_progress');
  assert.strictEqual(S.stageOf('Stuck'), 'blocked');
  assert.strictEqual(S.stageOf('On hold'), 'on_hold');
  assert.strictEqual(S.stageOf('Not started'), 'todo');
  assert.strictEqual(S.stageOf('Pending'), 'todo');
  assert.strictEqual(S.stageOf('Purple'), undefined);
});

test('people by email, username, full name or a unique first name', () => {
  const people = [
    { id: 1, name: 'Akhil Vallabhani', email: 'akhil@x.com', username: 'akhil' },
    { id: 2, name: 'Ravi Kumar', email: 'ravi@x.com', username: 'ravik' },
    { id: 3, name: 'Ravi Teja', email: 'teja@x.com', username: 'teja' },
  ];
  assert.deepStrictEqual(S.matchPeople('Akhil', people), { ids: [1], unknown: [] });
  assert.deepStrictEqual(S.matchPeople('ravi@x.com, Ravi Teja', people), { ids: [2, 3], unknown: [] });
  assert.deepStrictEqual(S.matchPeople('Ravi', people), { ids: [], unknown: ['Ravi'] }); // two Ravis
  assert.deepStrictEqual(S.matchPeople('@teja and Nobody', people), { ids: [3], unknown: ['Nobody'] });
});

test('custom cells', () => {
  assert.deepStrictEqual(S.readCustom('date', '5 Nov 2026'), { date: '2026-11-05' });
  assert.deepStrictEqual(S.readCustom('link', 'www.vgrand.in'), { url: 'https://www.vgrand.in' });
  assert.strictEqual(S.readCustom('phone', '9.87654321E+09'), '9876543210');
  assert.strictEqual(S.readCustom('progress', '0.75'), 75);
  assert.strictEqual(S.readCustom('progress', '75%'), 75);
  assert.strictEqual(S.readCustom('rating', '★★★'), 3);
  assert.strictEqual(S.readCustom('rating', '4/5'), 4);
  assert.deepStrictEqual(S.readCustom('tags', 'a, b; c'), ['a', 'b', 'c']);
  assert.strictEqual(S.readCustom('text', ''), null);
  assert.strictEqual(S.readCustom('files', 'x.pdf'), undefined);
});
