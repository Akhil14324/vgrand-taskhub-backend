const test = require('node:test');
const assert = require('node:assert/strict');
const {
  mentionsClaude, parseRepos, repoLabel, isClaudeUser, tokenForRepo, slugify, branchName, buildPrompt, signBody, verifySignature, isFresh, prNumberFromUrl,
} = require('./claudeRun');

test('mentionsClaude finds @claude as a word only', () => {
  assert.equal(mentionsClaude('@claude fix the footer'), true);
  assert.equal(mentionsClaude('please @Claude, help'), true);
  assert.equal(mentionsClaude('ask @claude.'), true);
  assert.equal(mentionsClaude('mail me@claude.com'), false);
  assert.equal(mentionsClaude('hi @claudette'), false);
  assert.equal(mentionsClaude('no mention', null, undefined, 'still none'), false);
  assert.equal(mentionsClaude('nothing', 'but here: @claude'), true);
});

test('parseRepos reads the env format and falls back to the defaults', () => {
  assert.deepEqual(parseRepos('mobile=a/b, backend=c/d'), { mobile: 'a/b', backend: 'c/d' });
  assert.deepEqual(parseRepos('bad,=x/y,web=nope,ok=o/r'), { ok: 'o/r' });
  assert.ok(parseRepos('').mobile && parseRepos(undefined).backend);
});

test('branch names are safe and unique per run', () => {
  assert.equal(slugify('@claude Fix the Footer text!!'), 'fix-the-footer-text');
  assert.equal(slugify('@claude'), 'task');
  assert.equal(branchName(7, '@claude Add dark mode'), 'claude/task-7-add-dark-mode');
  assert.ok(!/[^a-z0-9/-]/.test(branchName(1, '../../etc; rm -rf *')));
});

test('buildPrompt drops the trigger, includes sub-tasks and discussion, and is capped', () => {
  const prompt = buildPrompt({
    title: '@claude change the footer',
    notes: 'Make it say VGrand\n@claude thanks',
    subtasks: [{ title: 'Check mobile', is_done: true }, { title: 'Check desktop', notes: 'wide screens' }],
    comments: [{ author: 'Akhil', body: 'also the copyright year' }],
  });
  assert.match(prompt, /^Task: change the footer/);
  assert.ok(!/@claude/i.test(prompt));
  assert.match(prompt, /- \[x\] Check mobile/);
  assert.match(prompt, /- \[ \] Check desktop — wide screens/);
  assert.match(prompt, /Akhil: also the copyright year/);
  assert.ok(buildPrompt({ title: 'x', notes: 'y'.repeat(50000) }, { maxLength: 1000 }).length <= 1000);
});

test('signatures verify only for the same secret and body', () => {
  const body = JSON.stringify({ run_id: 3, status: 'pr_ready', ts: 1 });
  const sig = signBody('s3cret', body);
  assert.equal(verifySignature('s3cret', body, sig), true);
  assert.equal(verifySignature('other', body, sig), false);
  assert.equal(verifySignature('s3cret', body + ' ', sig), false);
  assert.equal(verifySignature('s3cret', body, 'sha256=short'), false);
  assert.equal(verifySignature('', body, sig), false);
  assert.equal(verifySignature('s3cret', body, undefined), false);
});

test('timestamps must be recent', () => {
  const now = 1_000_000_000_000;
  assert.equal(isFresh(now - 60_000, now), true);
  assert.equal(isFresh(now - 11 * 60_000, now), false);
  assert.equal(isFresh('nope', now), false);
});

test('prNumberFromUrl', () => {
  assert.equal(prNumberFromUrl('https://github.com/o/r/pull/42'), 42);
  assert.equal(prNumberFromUrl('https://github.com/o/r/issues/42'), null);
});

test('only the allowed usernames may use Claude (default: akhil)', () => {
  assert.equal(isClaudeUser('akhil'), true);
  assert.equal(isClaudeUser('Akhil', ''), true);
  assert.equal(isClaudeUser('someone'), false);
  assert.equal(isClaudeUser(undefined), false);
  assert.equal(isClaudeUser('b', 'a, b'), true);
});

test('repo labels', () => {
  assert.equal(repoLabel('mobile'), 'Web app');
  assert.equal(repoLabel('crm-portal'), 'Crm portal');
});

test('tokens are chosen per GitHub owner, with a default', () => {
  const env = { CLAUDE_GITHUB_TOKEN: 'default', CLAUDE_GITHUB_TOKEN_VARUNKUMAR06011: 'varun' };
  assert.equal(tokenForRepo('varunkumar06011/softshape-backend', env), 'varun');
  assert.equal(tokenForRepo('Akhil14324/Taskhub-mobile', env), 'default');
  assert.equal(tokenForRepo('someone/else', {}), null);
  assert.equal(tokenForRepo('my-org/x', { CLAUDE_GITHUB_TOKEN_MY_ORG: 'org' }), 'org');
});
