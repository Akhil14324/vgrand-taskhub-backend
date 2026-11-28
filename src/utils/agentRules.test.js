const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const r = require('./agentRules');

const prod = { NODE_ENV: 'production', MCP_ENABLED: 'true', MCP_PUBLIC_URL: 'https://api.example.com', OPEN_PASSWORD_RESET: 'false' };

test('MCP is off by default, and in production needs https and password reset closed', () => {
  assert.equal(r.mcpConfig({}).on, false);
  assert.equal(r.mcpConfig(prod).on, true);
  assert.equal(r.mcpConfig({ ...prod, OPEN_PASSWORD_RESET: '' }).on, false);
  assert.equal(r.mcpConfig({ ...prod, MCP_PUBLIC_URL: 'http://api.example.com' }).on, false);
  assert.equal(r.mcpConfig({ ...prod, MCP_PUBLIC_URL: '' }).on, false);
  assert.equal(r.mcpConfig({ MCP_ENABLED: 'true' }).base, 'http://localhost:5000');
});

test('nobody may connect an agent until a username or * is listed', () => {
  assert.equal(r.mayConnect(r.mcpConfig(prod), 'akhil'), false);
  assert.equal(r.mayConnect(r.mcpConfig({ ...prod, MCP_ALLOWED_USERNAMES: 'Akhil, x' }), 'akhil'), true);
  assert.equal(r.mayConnect(r.mcpConfig({ ...prod, MCP_ALLOWED_USERNAMES: '*' }), 'anyone'), true);
});

test('agent redirect addresses', () => {
  for (const ok of ['https://claude.ai/cb', 'http://localhost:3000/cb', 'http://127.0.0.1/cb', 'cursor://x/cb']) assert.equal(r.validRedirect(ok), true, ok);
  for (const no of ['http://example.com/cb', 'javascript:alert(1)', 'data:text/html,x', 'https://a.com/cb#x', 'https://u:p@a.com/', 'nonsense']) assert.equal(r.validRedirect(no), false, no);
  assert.equal(r.redirectMatches(['https://a.com/cb'], 'https://a.com/cb'), true);
  assert.equal(r.redirectMatches(['https://a.com/cb'], 'https://a.com/cb2'), false);
  assert.equal(r.redirectMatches(['https://a.com/cb'], 'https://a.com:444/cb'), false);
  assert.equal(r.redirectMatches(['http://localhost:1111/cb'], 'http://localhost:2222/cb'), true);
  assert.equal(r.redirectMatches(['http://localhost:1111/cb'], 'http://localhost:1111/other'), false);
});

test('PKCE accepts only the matching verifier', () => {
  const verifier = 'v'.repeat(50);
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  assert.equal(r.verifierMatches(verifier, challenge), true);
  assert.equal(r.verifierMatches('w'.repeat(50), challenge), false);
  assert.equal(r.verifierMatches(undefined, challenge), false);
  assert.equal(r.verifierMatches('short', challenge), false);
});
