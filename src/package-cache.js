// Thunderstore and Hexium package lists, cached under .cache/.

const fs = require('fs');
const path = require('path');
const { ROOT, config } = require('./context');

// ---- Package-list cache (Thunderstore + Hexium) ----
//
// The Thunderstore package list is a very large JSON blob, and update
// checking used to be the slowest part of loading the Mods tab by far:
//   1. /api/mods/installed checks every mod IN PARALLEL, and with a cold (or
//      just-expired) cache every one of those parallel checks started its
//      OWN full download of the package list — 40 mods = 40 simultaneous
//      downloads of the same file. Now concurrent callers share one
//      in-flight request.
//   2. After 5 minutes the cache expired and the next page load paid the
//      full download again. Now it's stale-while-revalidate: an expired list
//      is still returned instantly while a fresh copy downloads in the
//      background (the next load picks it up).
//   3. The cache now survives GUI restarts (saved under .cache/ in the
//      project folder) and is warmed at startup, so even the first load after
//      `npm start` is fast.
const PKG_CACHE_DIR = path.join(ROOT, '.cache');
const PKG_FRESH_MS = 15 * 60 * 1000; // younger than this: used without refreshing
const pkgCaches = {}; // key -> { time, data, inflight }

function pkgCacheFile(key) {
  return path.join(PKG_CACHE_DIR, `${key}-packages.v2.json`);
}

function loadPkgCacheFromDisk(key) {
  try {
    const file = pkgCacheFile(key);
    const stat = fs.statSync(file);
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(data) && data.length) return { time: stat.mtimeMs, data };
  } catch (e) {
    // no cache yet / unreadable — fine
  }
  return null;
}

function savePkgCacheToDisk(key, data) {
  fs.promises
    .mkdir(PKG_CACHE_DIR, { recursive: true })
    .then(() => fs.promises.writeFile(pkgCacheFile(key), JSON.stringify(data)))
    .catch((e) => console.error(`[pkg-cache] could not save ${key} cache:`, e.message));
}

async function cachedPackages(key, fetcher) {
  let c = pkgCaches[key];
  if (!c) {
    c = pkgCaches[key] = loadPkgCacheFromDisk(key) || { time: 0, data: null };
  }
  const refresh = () => {
    if (!c.inflight) {
      const started = Date.now();
      c.inflight = fetcher()
        .then((data) => {
          if (Array.isArray(data) && data.length) {
            c.data = data;
            c.time = Date.now();
            savePkgCacheToDisk(key, data);
            console.log(`[pkg-cache] ${key}: ${data.length} packages in ${Date.now() - started} ms`);
          }
          return c.data || data;
        })
        .finally(() => {
          c.inflight = null;
        });
    }
    return c.inflight;
  };
  if (c.data) {
    if (Date.now() - c.time > PKG_FRESH_MS) refresh().catch((e) => console.error(`[pkg-cache] ${key} refresh failed:`, e.message));
    return c.data;
  }
  return refresh();
}

// Only the fields this file actually reads are kept (owner, name, full_name,
// is_deprecated, versions[].version_number/dependencies, and description/
// downloads for the latest version). The raw Thunderstore listing carries a
// lot more per version (icons, URLs, dates, older descriptions…), which is
// what used to push the dashboard's memory well past 300 MB.
function slimPackage(p) {
  const versions = (p.versions || []).map((v, i) => {
    const out = { version_number: v.version_number, dependencies: v.dependencies || [] };
    if (i === 0) {
      out.description = v.description;
      out.downloads = v.downloads;
    }
    return out;
  });
  return { owner: p.owner, name: p.name, full_name: p.full_name, is_deprecated: !!p.is_deprecated, versions };
}

// Streams a (very large) top-level JSON array and parses it one element at a
// time, so memory never holds the whole multi-hundred-MB document at once.
async function fetchJsonArrayStreaming(url, mapFn) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  const out = [];
  let depth = 0;
  let inString = false;
  let escaped = false;
  let pieces = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const text = decoder.decode(value, { stream: true });
    let start = depth >= 1 ? 0 : -1;
    for (let i = 0; i < text.length; i++) {
      const ch = text.charCodeAt(i);
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === 92) escaped = true; // backslash
        else if (ch === 34) inString = false; // "
        continue;
      }
      if (ch === 34) {
        inString = true;
      } else if (ch === 123 || ch === 91) {
        // { or [
        depth++;
        if (depth === 2) start = i; // an element of the top-level array begins
      } else if (ch === 125 || ch === 93) {
        // } or ]
        if (depth === 2) {
          pieces.push(text.slice(start, i + 1));
          const item = mapFn(JSON.parse(pieces.join('')));
          if (item) out.push(item);
          pieces = [];
          start = -1;
        }
        depth--;
      }
    }
    if (depth >= 2 && start >= 0) pieces.push(text.slice(start));
    else if (depth >= 2) pieces.push(text);
  }
  return out;
}

async function getThunderstorePackages() {
  return cachedPackages('thunderstore', () =>
    fetchJsonArrayStreaming(`https://thunderstore.io/c/${config.thunderstoreCommunity}/api/v1/package/`, slimPackage)
  );
}

Object.assign(module.exports, { slimPackage, cachedPackages, getThunderstorePackages });
