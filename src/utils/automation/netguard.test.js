const test = require('node:test');
const assert = require('node:assert');
const { isPrivateIp, checkUrl } = require('./netguard');

test('private, loopback and link-local addresses are refused', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.9', '172.20.0.1', '169.254.169.254', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1', '100.64.0.1']) {
    assert.strictEqual(isPrivateIp(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) assert.strictEqual(isPrivateIp(ip), false, ip);
});

test('checkUrl allows public addresses only', async () => {
  const lookup = async (host) => (host === 'good.example' ? [{ address: '93.184.216.34' }] : [{ address: '10.0.0.5' }]);
  assert.strictEqual((await checkUrl('https://good.example/path?q=1', lookup)).address, '93.184.216.34');
  await assert.rejects(checkUrl('http://internal.example/', lookup), /not public/);
  await assert.rejects(checkUrl('http://localhost/', lookup), /not public/);
  await assert.rejects(checkUrl('http://169.254.169.254/latest/meta-data', lookup), /not public/);
  await assert.rejects(checkUrl('ftp://good.example/', lookup), /http/);
  await assert.rejects(checkUrl('https://good.example:22/', lookup), /port/);
  await assert.rejects(checkUrl('https://user:pw@good.example/', lookup), /header/);
  await assert.rejects(checkUrl('not a url', lookup), /web address/);
});
