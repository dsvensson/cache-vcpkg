const core = require('@actions/core');
const cache = require('@actions/cache');
const fs = require('fs');
const path = require('path');
const {
  getArchivesDir,
  snapshotArchives,
  computeScope,
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
    const archivesDir = getArchivesDir();

    // ---- Compute scope from vcpkg commit + overlay ports ----
    const scope = computeScope(vcpkgRoot || null, overlayPorts || null);
    const keyPrefix = scope ? `${prefix}-${scope}` : prefix;

    if (scope) core.info(`Cache scope: ${scope}`);
    if (vcpkgRoot && !scope) {
      core.warning(
        `vcpkg-root was set but no git commit could be read from: ${vcpkgRoot}`,
      );
    }

    core.info(`Archives dir: ${archivesDir}`);
    fs.mkdirSync(archivesDir, { recursive: true });

    // ---- List known cache entries via GitHub REST API ----
    const allKeys = await listCacheKeys(`${keyPrefix}-`, token);
    core.info(
      `Found ${allKeys.length} cache entries with prefix "${keyPrefix}"`,
    );

    // Deduplicate: extract ABI hash from key, keep first occurrence
    const seen = new Set();
    const tasks = [];
    for (const key of allKeys) {
      const hash = key.slice(keyPrefix.length + 1);
      if (!hash || seen.has(hash)) continue;
      seen.add(hash);
      tasks.push({ key, hash });
    }

    // ---- Restore each package in batches ----
    let restored = 0;
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
    core.info(`Restored ${restored} / ${tasks.length} packages`);

    // ---- Snapshot current state so post step can diff ----
    const snapshot = Array.from(snapshotArchives(archivesDir));
    core.saveState('snapshot', JSON.stringify(snapshot));
    core.saveState('archives-dir', archivesDir);
    core.saveState('scope', scope);
    core.saveState('prefix', prefix);

    // ---- Expose the path for vcpkg configuration ----
    core.setOutput('archives-dir', archivesDir);
    core.exportVariable(
      'VCPKG_BINARY_SOURCES',
      `files,${archivesDir},readwrite`,
    );
  } catch (err) {
    // Never fail the build for cache issues
    core.warning(`vcpkg cache restore failed: ${err.message}`);
  }
}

run();
