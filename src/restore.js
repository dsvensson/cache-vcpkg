const core = require('@actions/core');
const cache = require('@actions/cache');
const fs = require('fs');
const path = require('path');
const {
  getArchivesDir,
  snapshotArchives,
  hashFromCacheKey,
  computeScope,
  manifestPath,
  manifestKey,
  manifestRestoreKey,
  MANIFEST_DIR,
} = require('./common');

const CONCURRENCY = 10;

async function listCacheKeys(listPrefix, token) {
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) throw new Error('GITHUB_REPOSITORY not set');

  const keys = [];
  let page = 1;

  while (true) {
    const url =
      `https://api.github.com/repos/${repo}/actions/caches` +
      `?key=${encodeURIComponent(listPrefix)}&per_page=100&page=${page}&sort=last_accessed_at&direction=desc`;

    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });

    if (!res.ok) {
      const body = await res.text();
      core.warning(`Cache list API returned ${res.status}: ${body}`);
      break;
    }

    const data = await res.json();
    const entries = data.actions_caches || [];
    for (const c of entries) keys.push(c.key);
    if (entries.length < 100) break;
    page++;
  }

  return keys;
}

async function run() {
  try {
    const token = core.getInput('token', { required: true });
    core.setSecret(token);
    const prefix = core.getInput('cache-key-prefix') || 'vcpkg-pkg';
    const vcpkgRoot = core.getInput('vcpkg-root') || '';
    const overlayPorts = core.getInput('overlay-ports') || '';
    const extraKey = core.getInput('key') || '';
    const saveCache = core.getInput('save-cache') !== 'false';
    const archivesDir = getArchivesDir();

    // ---- Compute scope from vcpkg commit + overlay ports + key ----
    const scope = computeScope(
      vcpkgRoot || null,
      overlayPorts || null,
      extraKey || null,
    );
    const keyPrefix = scope ? `${prefix}-${scope}` : prefix;

    if (vcpkgRoot && !scope) {
      core.warning(
        `vcpkg-root was set but no git commit could be read from: ${vcpkgRoot}`,
      );
    }

    fs.mkdirSync(archivesDir, { recursive: true });

    // ---- Check manifest for cache-hit ----
    let cacheHit = false;
    fs.mkdirSync(MANIFEST_DIR, { recursive: true });
    const mPath = manifestPath();
    const mKey = manifestKey(prefix, scope);
    const mRestoreKey = manifestRestoreKey(prefix, scope);

    const mHit = await cache.restoreCache([mPath], mKey, [mRestoreKey]);

    // ---- List known cache entries via GitHub REST API ----
    const allKeys = await listCacheKeys(`${keyPrefix}-`, token);

    // Deduplicate: extract ABI hash from key (last 64 hex chars)
    const seen = new Set();
    const tasks = [];
    for (const key of allKeys) {
      const hash = hashFromCacheKey(key);
      if (!hash || seen.has(hash)) continue;
      seen.add(hash);
      tasks.push({ key, hash });
    }

    // ---- Evaluate cache-hit against manifest ----
    if (mHit && fs.existsSync(mPath)) {
      try {
        const manifest = JSON.parse(fs.readFileSync(mPath, 'utf-8'));
        const expected = manifest.hashes || [];
        if (expected.length > 0) {
          const missing = expected.filter(h => !seen.has(h));
          cacheHit = missing.length === 0;
          if (cacheHit) {
            core.info(
              `Cache hit — all ${expected.length} packages present`,
            );
          } else {
            core.info(
              `Cache miss — ${missing.length}/${expected.length} packages missing`,
            );
          }
        }
      } catch {
        core.debug('Failed to parse manifest');
      }
    }

    core.setOutput('cache-hit', cacheHit ? 'true' : 'false');

    // ---- Builder can skip restore when cache is complete ----
    if (cacheHit && saveCache) {
      core.saveState('save-cache', 'true');
      core.saveState('archives-dir', archivesDir);
      core.saveState('scope', scope);
      core.saveState('prefix', prefix);
      const mode = 'readwrite';
      core.setOutput('archives-dir', archivesDir);
      core.exportVariable(
        'VCPKG_BINARY_SOURCES',
        `files,${archivesDir},${mode}`,
      );
      return;
    }

    // ---- Restore each package in batches ----
    let restored = 0;
    await core.group(
      `Restoring ${tasks.length} cached packages (scope: ${scope || 'none'})`,
      async () => {
        for (let i = 0; i < tasks.length; i += CONCURRENCY) {
          const batch = tasks.slice(i, i + CONCURRENCY);
          const results = await Promise.allSettled(
            batch.map(async ({ key, hash }) => {
              const subdir = hash.slice(0, 2);
              const zipPath = path.join(archivesDir, subdir, `${hash}.zip`);
              fs.mkdirSync(path.join(archivesDir, subdir), { recursive: true });

              const hit = await cache.restoreCache([zipPath], key);
              if (hit) {
                restored++;
                return true;
              }
              return false;
            }),
          );
          for (const r of results) {
            if (r.status === 'rejected') {
              core.warning(`Restore failed: ${r.reason?.message || r.reason}`);
            }
          }
        }
      },
    );
    core.info(`Restored ${restored} / ${tasks.length} packages`);

    // ---- Snapshot current state so post step can diff ----
    if (saveCache) {
      const snapshot = Array.from(snapshotArchives(archivesDir));
      core.saveState('snapshot', JSON.stringify(snapshot));
    }
    core.saveState('save-cache', saveCache ? 'true' : 'false');
    core.saveState('archives-dir', archivesDir);
    core.saveState('scope', scope);
    core.saveState('prefix', prefix);

    // ---- Expose the path for vcpkg configuration ----
    const mode = saveCache ? 'readwrite' : 'read';
    core.setOutput('archives-dir', archivesDir);
    core.exportVariable(
      'VCPKG_BINARY_SOURCES',
      `files,${archivesDir},${mode}`,
    );
  } catch (err) {
    // Never fail the build for cache issues
    core.warning(`vcpkg cache restore failed: ${err.message}`);
  }
}

run();
