'use strict';
// Loaded into a test GUI with NODE_OPTIONS=--require, so tests never reach Thunderstore or Hexium.
const real = global.fetch;
const pkg = (owner, name, versions) => ({ name, full_name: `${owner}-${name}`, owner, is_deprecated: false, versions: versions.map((v) => ({ name, full_name: `${owner}-${name}-${v}`, description: name, version_number: v, dependencies: [], downloads: 1 })) });
const LIST = [pkg('A', 'One', ['1.0.0']), pkg('B', 'Two', ['2.0.0', '1.0.0'])];
global.fetch = async (url, opts) => {
  const u = String(url);
  if (u.startsWith('https://thunderstore.io/c/') && u.includes('/api/v1/package/')) return new Response(JSON.stringify(LIST), { status: 200, headers: { 'content-type': 'application/json' } });
  if (u.includes('hexium.gg')) return new Response('not found', { status: 404 });
  return real(url, opts);
};
