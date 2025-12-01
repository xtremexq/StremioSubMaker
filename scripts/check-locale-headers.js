#!/usr/bin/env node
/**
 * Quick regression check to ensure /api/locale responses stay non-cacheable
 * and bypass CDN/proxy caches. Run while the server is up:
 *   CHECK_URL=http://localhost:7001 npm run check:locale-headers
 */
const fetch = require('node-fetch');

const baseUrl = process.env.CHECK_URL || `http://localhost:${process.env.PORT || 7001}`;
const target = new URL('/api/locale?lang=en', baseUrl);

async function main() {
  const requiredHeaders = [
    ['cache-control', /no-store/i],
    ['pragma', /no-cache/i],
    ['surrogate-control', /no-store/i],
    ['cdn-cache-control', /no-store/i],
    ['cloudflare-cdn-cache-control', /no-store/i],
    ['cf-cache-status', /bypass/i],
    ['vary', /\*/]
  ];

  const res = await fetch(target.toString(), { redirect: 'manual' }).catch((err) => {
    console.error(`ERROR: Could not reach ${target.toString()}. Is the server running? (${err.message})`);
    process.exit(1);
  });

  if (!res.ok) {
    console.error(`ERROR: Unexpected status ${res.status} from ${target.pathname}`);
    process.exit(1);
  }

  const missing = [];
  requiredHeaders.forEach(([name, pattern]) => {
    const value = res.headers.get(name);
    if (!value || !pattern.test(value)) {
      missing.push(`${name} (got: ${value || 'missing'})`);
    }
  });

  if (missing.length > 0) {
    console.error('ERROR: Missing/incorrect cache-bypass headers:', missing.join('; '));
    process.exit(1);
  }

  console.log('OK: /api/locale returned required no-store/CDN-bypass headers.');
}

main().catch((err) => {
  console.error('ERROR: Failed to verify locale headers:', err);
  process.exit(1);
});
