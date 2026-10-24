const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

// Stub the database and notifications before the service loads them.
const queries = [];
let linked = [];
const dbStub = {
  query: async (text, params) => {
    queries.push({ text, params });
    if (text.includes("preferences->'erp'->>'userId' IS NOT NULL")) return { rows: linked };
    if (text.includes("SELECT preferences->'erp' AS erp")) {
      const row = linked.find((l) => l.id === params[0]);
      return { rows: [{ erp: row ? row.erp : null }] };
    }
    return { rows: [] };
  },
};
const notices = [];
const emits = [];
const notifyStub = {
  notify: async (ids, n) => { notices.push({ ids, ...n }); },
  emitToUsers: (ids, event, payload) => { emits.push({ ids, event, payload }); },
};
require.cache[path.join(__dirname, '../db/index.js')] = { exports: dbStub, loaded: true, id: 'db' };
require.cache[path.join(__dirname, '../utils/notify.js')] = { exports: notifyStub, loaded: true, id: 'notify' };

process.env.ERP_API_URL = 'https://erp.example.com/api/';
process.env.TASKHUB_SYNC_SECRET = 'shared-secret';

const erp = require('./erpApprovals');

let erpAnswer;
const calls = [];
global.fetch = async (url, init) => {
  calls.push({ url, init });
  return { ok: true, status: 200, json: async () => erpAnswer };
};

const item = (id, over = {}) => ({
  kind: 'PO', id, number: `VGH-${id}`, action: 'APPROVE', party: 'Lakshmi Steel', amount: 1000,
  project: { id: 'p1', code: 'VGH', name: 'V Grand' }, url: `https://erp/pos?id=${id}&project=p1`, ...over,
});
const answer = (items, over = {}) => ({
  user: { id: 'erp-1', name: 'Ravi', role: 'PROJECT_HEAD', roleLabel: 'Project Head' }, eligible: true, items, generatedAt: 'now', ...over,
});

test('first read is quiet, later reads notify only what is new, and the badge count follows', async () => {
  linked = [{ id: 7, erp: { userId: 'erp-1', name: 'Ravi' } }];

  erpAnswer = answer([item('PO1')]);
  await erp.syncAll();
  assert.equal(notices.length, 0, 'what was already waiting is not announced');
  assert.equal(erp.cachedCount(7), 1);
  assert.equal(calls[0].url, 'https://erp.example.com/api/integrations/taskhub/approvals?erpUserId=erp-1');
  assert.equal(calls[0].init.headers['x-taskhub-secret'], 'shared-secret');

  erpAnswer = answer([item('PO1'), item('PO2')]);
  await erp.syncAll();
  assert.equal(notices.length, 1);
  assert.deepEqual(notices[0].ids, [7]);
  assert.equal(notices[0].type, 'erp_approval');
  assert.equal(notices[0].title, 'PO VGH-PO2 needs your approval');
  assert.equal(notices[0].data.url, 'https://erp/pos?id=PO2&project=p1');
  assert.equal(erp.cachedCount(7), 2);
  assert.ok(emits.some((e) => e.event === 'erp:approvals' && e.payload.count === 2));

  const emitted = emits.length;
  await erp.syncAll();
  assert.equal(notices.length, 1, 'nothing new, nothing sent');
  assert.equal(emits.length, emitted, 'an unchanged list does not ping the app');

  erpAnswer = answer(['A', 'B', 'C', 'D', 'E'].map((id) => item(id)));
  await erp.syncAll();
  assert.equal(notices.length, 2, 'a burst becomes one summary');
  assert.equal(notices[1].title, '5 ERP approvals are waiting on you');
});

test('a deactivated ERP account is unlinked; someone no longer an approver counts zero', async () => {
  linked = [{ id: 8, erp: { userId: 'erp-2' } }];
  erpAnswer = answer([item('X')], { eligible: false, items: [] });
  await erp.syncAll();
  assert.equal(erp.cachedCount(8), 0);

  erpAnswer = { user: null, eligible: false, items: [] };
  queries.length = 0;
  await erp.syncAll();
  assert.ok(queries.some((q) => q.text.includes("preferences = preferences - 'erp' WHERE id = $1") && q.params[0] === 8));
});

test('the screen falls back to the last list when the ERP cannot be reached', async () => {
  linked = [{ id: 9, erp: { userId: 'erp-3', name: 'Asha', roleLabel: 'Admin 1' } }];
  erpAnswer = answer([item('Q1')]);
  const first = await erp.getApprovals(9, { fresh: true });
  assert.equal(first.items.length, 1);

  global.fetch = async () => { throw new Error('ECONNREFUSED'); };
  const down = await erp.getApprovals(9, { fresh: true });
  assert.equal(down.linked, true);
  assert.equal(down.items.length, 1);
  assert.match(down.error, /Could not reach/);
});

test('a code must be six digits before the ERP is asked', async () => {
  await assert.rejects(erp.link(9, '12 34'), (err) => err.code === 'CODE_INVALID' && err.statusCode === 400);
});
