const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(process.cwd(), 'index.js'), 'utf8');

// Build isLocalhost + isPrivateNetworkHost from index.js against a stub getSafeHost.
function loadHelpers() {
  const pick = (name) => {
    const start = source.indexOf(`function ${name}(req) {`);
    assert.notEqual(start, -1, `${name} should exist`);
    const end = source.indexOf('\n}\n', start);
    return source.slice(start, end + 2);
  };
  // eslint-disable-next-line no-new-func
  return new Function('getSafeHost', `${pick('isLocalhost')}\n${pick('isPrivateNetworkHost')}\nreturn { isLocalhost, isPrivateNetworkHost };`)(
    (req) => req.host
  );
}

test('docker service names and LAN hosts keep their own protocol', () => {
  const { isPrivateNetworkHost } = loadHelpers();
  for (const host of ['submaker:7001', 'submaker', 'aiostreams:3000', 'nas', 'localhost:7001', '127.0.0.1:7001', '192.168.1.20:7001', '10.0.0.5', '172.18.0.4:7001']) {
    assert.equal(isPrivateNetworkHost({ host }), true, host);
  }
});

test('public host names are still treated as remote', () => {
  const { isPrivateNetworkHost } = loadHelpers();
  for (const host of ['submaker.example.com', 'example.com:443', 'subs.duckdns.org', '8.8.8.8', '172.32.0.1', '-bad', 'bad-']) {
    assert.equal(isPrivateNetworkHost({ host }), false, host);
  }
});

test('isLocalhost itself is unchanged and still decides sessions and config', () => {
  const { isLocalhost } = loadHelpers();
  assert.equal(isLocalhost({ host: 'submaker:7001' }), false);
  assert.equal(isLocalhost({ host: '192.168.1.20:7001' }), true);
  assert.equal((source.match(/const localhost = isPrivateNetworkHost\(req\);/g) || []).length, 5);
  assert.match(source, /async function resolveConfigAsync\(configStr, req\) \{\n    const localhost = isLocalhost\(req\);/);
});
