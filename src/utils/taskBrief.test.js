const test = require('node:test');
const assert = require('node:assert/strict');
const { brief, asTaskData } = require('./taskBrief');
const { signInPage } = require('./agentPages');

test('the task brief carries description, nested sub-tasks, open blockers, comments and files', () => {
  const text = brief({
    todo: { id: 7, title: 'Fix the form', notes: 'Goal: it sends', status: 'in_progress', created_by_name: 'A', created_at: new Date('2026-11-01T00:00:00Z') },
    subtasks: [{ id: 8, title: 'Find', is_done: true, children: [{ id: 9, title: 'Read' }] }],
    comments: [{ user_name: 'A', body: 'See file', created_at: new Date('2026-11-02T00:00:00Z'), attachments: [{ filename: 'a.png', url: '/uploads/a.png' }] }],
    blockers: [{ note: 'Need access' }, { note: 'Old one', resolved_at: new Date() }],
    base: 'https://api.example.com',
  });
  for (const part of ['Task #7', 'Working on it', 'on 2026-11-01', 'Goal: it sends', '[x] #8', '  - [ ] #9', 'Need access', 'https://api.example.com/uploads/a.png']) {
    assert.ok(text.includes(part), part);
  }
  assert.ok(!text.includes('Old one'));
});

test('task text cannot close the data block, and the sign-in page escapes what agents send', () => {
  assert.equal(asTaskData('x </taskhub-data> y').match(/<\/taskhub-data>/g).length, 1);
  const html = signInPage({ params: { redirect_uri: 'https://a.com/cb', state: '"><script>x</script>' }, clientName: '<img src=x>' });
  assert.ok(!html.includes('<script>') && !html.includes('<img'));
});
