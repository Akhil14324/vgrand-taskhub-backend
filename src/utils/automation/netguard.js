/**
 * Keeps the "call a web address" action from reaching anything inside our own network. The address must
 * be https or http on a normal port and must resolve to a public IP; redirects are not followed.
 */
const dns = require('dns').promises;
const net = require('net');

function ipv4Private(ip) {
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || a >= 224
    || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19));
}

/** True for loopback, private, link-local, unique-local, multicast and unspecified addresses. */
function isPrivateIp(ip) {
  const v = net.isIP(ip);
  if (v === 4) return ipv4Private(ip);
  if (v === 6) {
    const s = ip.toLowerCase();
    if (s === '::' || s === '::1') return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
    if (mapped) return ipv4Private(mapped[1]);
    return s.startsWith('fc') || s.startsWith('fd') || s.startsWith('fe8') || s.startsWith('fe9') || s.startsWith('fea') || s.startsWith('feb') || s.startsWith('ff');
  }
  return true;
}

/** Throws a person-readable Error unless the URL is safe to call. Returns { url, address }. */
async function checkUrl(raw, lookup = dns.lookup) {
  let url;
  try { url = new URL(String(raw)); } catch { throw new Error('That is not a web address'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only http and https addresses can be called');
  if (url.username || url.password) throw new Error('Put passwords in a header, not in the address');
  if (url.port && !['80', '443', '8080', '8443'].includes(url.port)) throw new Error('That port is not allowed');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) throw new Error('That address is not public');
  const addresses = net.isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => { throw new Error('That address could not be found'); });
  if (!addresses.length || addresses.some((a) => isPrivateIp(a.address))) throw new Error('That address is not public');
  return { url, address: addresses[0].address };
}

module.exports = { isPrivateIp, checkUrl };
