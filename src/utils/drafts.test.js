const test = require('node:test');
const assert = require('node:assert');
const { cleanMeetingTasks, mergeTasks, guessBusiness, summarizeByPerson } = require('./drafts');

const people = {
  byUsername: new Map([
    ['kaushal', { id: 3, name: 'Kaushal', username: 'kaushal' }],
    ['nagarjuna', { id: 8, name: 'Nagarjuna', username: 'nagarjuna' }],
    ['vinod', { id: 2, name: 'T Vinod Kumar', username: 'vinod' }],
  ]),
};

test('a matched name is sure, an unmatched spoken name is unsure, no name is mine', () => {
  const out = cleanMeetingTasks([
    { title: 'Send the Tripura drawings', assignee: 'nagarjuna', assignee_said: 'Nagarjuna garu', quote: 'Nagarjuna, drawings pampinchandi' },
    { title: 'Fix the kitchen exhaust', assignee: null, assignee_said: 'Ravi' },
    { title: 'Call the bank', assignee: null, assignee_said: null },
    { title: 'Approve the budget', assignee: 'vinod' },
  ], people, 2);
  assert.deepStrictEqual(out.map((t) => [t.assignee_id, t.confidence]), [[8, 'sure'], [null, 'unsure'], [null, 'mine'], [null, 'mine']]);
  assert.strictEqual(out[0].quote, 'Nagarjuna, drawings pampinchandi');
});

test('bad dates and priorities are dropped; time needs a date', () => {
  const [t] = cleanMeetingTasks([{ title: 'x', due_date: '5/11', due_time: '10:00', priority: 9 }], people, 1);
  assert.deepStrictEqual([t.due_date, t.due_time, t.priority], [null, null, null]);
  const [u] = cleanMeetingTasks([{ title: 'x', due_date: '2026-11-05', due_time: '10:00', priority: 1 }], people, 1);
  assert.deepStrictEqual([u.due_date, u.due_time, u.priority], ['2026-11-05', '10:00', 1]);
});

test('more than 25 tasks survive (a long meeting sets many)', () => {
  const many = Array.from({ length: 150 }, (_, i) => ({ title: `Task ${i}` }));
  assert.strictEqual(cleanMeetingTasks(many, people, 1).length, 150);
});

test('repeated tasks across parts merge, keeping the sure reading', () => {
  const merged = mergeTasks([
    [{ title: 'Order cement', confidence: 'unsure', assignee_id: null }],
    [{ title: 'order cement', confidence: 'sure', assignee_id: 8 }, { title: 'Pay rent', confidence: 'mine', assignee_id: null }],
  ]);
  assert.strictEqual(merged.length, 2);
  assert.strictEqual(merged.find((t) => /cement/i.test(t.title)).assignee_id, 8);
});

test('business guess: meeting company, else their only company, else personal', () => {
  const memberships = new Map([[8, [2]], [6, [1, 7]], [3, [3]]]);
  const leaders = new Set([3]);
  assert.strictEqual(guessBusiness({ assigneeId: 8, meetingBusinessId: 2, memberships, leaders }), 2);
  assert.strictEqual(guessBusiness({ assigneeId: 8, meetingBusinessId: null, memberships, leaders }), 2);
  assert.strictEqual(guessBusiness({ assigneeId: 6, meetingBusinessId: null, memberships, leaders }), null);
  assert.strictEqual(guessBusiness({ assigneeId: 6, meetingBusinessId: 7, memberships, leaders }), 7);
  assert.strictEqual(guessBusiness({ assigneeId: 3, meetingBusinessId: 2, memberships, leaders }), 2);
  assert.strictEqual(guessBusiness({ assigneeId: null, meetingBusinessId: 2, memberships, leaders }), 2);
});

test('summary counts per person, unsure and mine', () => {
  const s = summarizeByPerson([
    { assignee_id: 3, confidence: 'sure' }, { assignee_id: 3, confidence: 'sure' }, { assignee_id: 8, confidence: 'sure' },
    { assignee_id: null, confidence: 'unsure' }, { assignee_id: null, confidence: 'mine' },
  ], (id) => ({ 3: 'Kaushal', 8: 'Nagarjuna' })[id]);
  assert.deepStrictEqual(s, { people: [{ id: 3, name: 'Kaushal', count: 2 }, { id: 8, name: 'Nagarjuna', count: 1 }], unsure: 1, mine: 1, total: 5 });
});
