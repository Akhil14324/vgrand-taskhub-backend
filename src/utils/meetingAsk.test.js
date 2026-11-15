const test = require('node:test');
const assert = require('node:assert');
const { cleanChart, cleanFlow, cleanReply, cleanDashboard, cleanHistory, fitTranscript } = require('./meetingAsk');

test('a chart keeps numbers in step with its categories', () => {
  const c = cleanChart({ chart: 'pie', title: 'Tasks per person', categories: ['Vinod', 'Kaushal', ''], series: [{ label: 'Tasks', values: [3, 'x', 9] }] });
  assert.equal(c.kind, 'chart');
  assert.equal(c.chart, 'pie');
  assert.deepEqual(c.categories.map((x) => x.label), ['Vinod', 'Kaushal']);
  assert.deepEqual(c.series[0].values, [3, 0]);
});

test('a chart with nothing to draw is dropped', () => {
  assert.equal(cleanChart({ categories: ['A'], series: [{ label: 'x', values: [0] }] }), null);
  assert.equal(cleanChart({ categories: [], series: [] }), null);
  assert.equal(cleanChart(null), null);
});

test('an unknown chart type falls back to columns', () => {
  assert.equal(cleanChart({ chart: 'radar', categories: ['A'], series: [{ values: [2] }] }).chart, 'column');
});

test('a flow chart drops arrows to boxes that do not exist, loops to itself and repeats', () => {
  const f = cleanFlow({
    title: 'Purchase',
    nodes: [{ id: 'a', label: 'Ask for quote', kind: 'start' }, { id: 'b', label: 'Approve', kind: 'weird', who: 'Kaushal' }, { id: 'a', label: 'again' }],
    edges: [{ from: 'a', to: 'b' }, { from: 'a', to: 'b' }, { from: 'a', to: 'zz' }, { from: 'b', to: 'b' }],
  });
  assert.equal(f.nodes.length, 2);
  assert.equal(f.nodes[1].kind, 'step');
  assert.equal(f.nodes[1].who, 'Kaushal');
  assert.deepEqual(f.edges, [{ from: 'a', to: 'b', label: null }]);
});

test('a flow chart needs at least two boxes', () => {
  assert.equal(cleanFlow({ nodes: [{ id: 'a', label: 'Only one' }], edges: [] }), null);
});

test('a reply always has words, and only a picture that can be drawn', () => {
  assert.deepEqual(cleanReply({ answer: '', visual: { kind: 'chart', categories: [] } }), { answer: 'I could not find that in this meeting.', visual: null });
  const r = cleanReply({ answer: 'Three tasks.', visual: { kind: 'flow', nodes: [{ id: '1', label: 'A' }, { id: '2', label: 'B' }], edges: [{ from: '1', to: '2' }] } });
  assert.equal(r.answer, 'Three tasks.');
  assert.equal(r.visual.kind, 'flow');
});

test('history keeps the newest eight turns with words', () => {
  const h = cleanHistory([...Array(12)].map((_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: `m${i}` })).concat([{ role: 'user', text: '' }]));
  assert.equal(h.length, 7);
  assert.equal(h[0].text, 'm5');
});

test('a very long transcript keeps its start and end', () => {
  const t = `START${'x'.repeat(1000)}END`;
  const out = fitTranscript(t, 200);
  assert.ok(out.cut);
  assert.ok(out.text.startsWith('START'));
  assert.ok(out.text.endsWith('END'));
  assert.equal(fitTranscript('short', 200).cut, false);
});

test('a dashboard keeps its usable tiles and charts and drops the rest', () => {
  const d = cleanDashboard({ title: 'Site meeting', tiles: [{ label: 'Tasks', value: 12 }, { label: '', value: 3 }], charts: [{ chart: 'bar', categories: ['Ravi', 'Sita'], series: [{ label: 'Tasks', values: [3, 2] }] }, { categories: [] }] });
  assert.strictEqual(d.kind, 'dashboard');
  assert.deepStrictEqual(d.tiles, [{ label: 'Tasks', value: '12', note: null }]);
  assert.strictEqual(d.charts.length, 1);
  assert.strictEqual(cleanDashboard({ tiles: [], charts: [] }), null);
  assert.strictEqual(cleanReply({ answer: 'Here', visual: { kind: 'dashboard', tiles: [{ label: 'Decisions', value: '4' }] } }).visual.tiles.length, 1);
});
