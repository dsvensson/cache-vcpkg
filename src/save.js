const core = require('@actions/core');
const cache = require('@actions/cache');
const path = require('path');
const {
  getArchivesDir,
  snapshotArchives,
  hashFromRelPath,
  cacheKeyFor,
} = require('./common');

const CONCURRENCY = 10;

async function run() {
  try {
    const prefix =
      core.getState('prefix') ||
      core.getInput('cache-key-prefix') ||
      'vcpkg-pkg';
    const scope = core.getState('scope') || '';
    const archivesDir = core.getState('archives-dir') || getArchivesDir();

    const oldSnapshot = new Set(
      JSON.parse(core.getState('snapshot') || '[]'),
    );
    const currentFiles = snapshotArchives(archivesDir);
    const newFiles = Array.from(currentFiles).filter(
      f => !oldSnapshot.has(f),
    );

    core.info(`New packages to cache: ${newFiles.length}`);
    if (newFiles.length === 0) return;

    let saved = 0;
    for (let i = 0; i < newFiles.length; i += CONCURRENCY) {
      const batch = newFiles.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map(async relPath => {
          const hash = hashFromRelPath(relPath);
          const key = cacheKeyFor(prefix, scope, hash);
          const zipPath = path.join(archivesDir, relPath);

          try {
            await cache.saveCache([zipPath], key);
            saved++;
            core.info(`Cached ${hash}`);
          } catch (e) {
            // "already exists" is benign — another job may have saved it first
            if (e.message && e.message.includes('already exists')) {
              core.info(`Already cached: ${hash}`);
            } else {
              throw e;
            }
          }
        }),
      );

      for (const r of results) {
        if (r.status === 'rejected') {
          core.warning(`Save failed: ${r.reason?.message || r.reason}`);
        }
      }
    }
    core.info(`Saved ${saved} new packages to cache`);
  } catch (err) {
    core.warning(`vcpkg cache save failed: ${err.message}`);
  }
}

run();
