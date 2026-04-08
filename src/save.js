const core = require('@actions/core');
const cache = require('@actions/cache');
const fs = require('fs');
const path = require('path');
const {
  getArchivesDir,
  snapshotArchives,
  hashFromRelPath,
  cacheKeyFor,
  parseVcpkgStatus,
  manifestPath,
  manifestKey,
  MANIFEST_DIR,
} = require('./common');

const CONCURRENCY = 10;

function findInstalledDir() {
  const input = core.getInput('installed-dir');
  if (input && fs.existsSync(path.join(input, 'vcpkg', 'status'))) return input;

  const workspace = process.env.GITHUB_WORKSPACE || process.cwd();
  const candidate = path.join(workspace, 'vcpkg_installed');
  if (fs.existsSync(path.join(candidate, 'vcpkg', 'status'))) return candidate;

  return null;
}

async function run() {
  try {
    if (core.getState('save-cache') === 'false') {
      core.info('Cache saving is disabled (save-cache: false)');
      return;
    }

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

    // ---- Save new packages ----
    if (newFiles.length > 0) {
      const installedDir = findInstalledDir();
      const abiToPort = installedDir
        ? parseVcpkgStatus(installedDir)
        : new Map();

      if (abiToPort.size > 0) {
        core.info(
          `Resolved ${abiToPort.size} port names from status database`,
        );
      }

      let saved = 0;
      await core.group(
        `Saving ${newFiles.length} new packages to cache`,
        async () => {
          for (let i = 0; i < newFiles.length; i += CONCURRENCY) {
            const batch = newFiles.slice(i, i + CONCURRENCY);
            const results = await Promise.allSettled(
              batch.map(async relPath => {
                const hash = hashFromRelPath(relPath);
                const portName = abiToPort.get(hash) || '';
                const key = cacheKeyFor(prefix, scope, portName, hash);
                const zipPath = path.join(archivesDir, relPath);

                try {
                  await cache.saveCache([zipPath], key);
                  saved++;
                } catch (e) {
                  if (e.message && e.message.includes('already exists')) {
                    core.debug(`Already cached: ${hash}`);
                  } else {
                    throw e;
                  }
                }
              }),
            );

            for (const r of results) {
              if (r.status === 'rejected') {
                core.warning(
                  `Save failed: ${r.reason?.message || r.reason}`,
                );
              }
            }
          }
        },
      );
      core.info(`Saved ${saved} new packages to cache`);
    } else {
      core.info('No new packages to cache');
    }

    // ---- Save manifest (list of all ABI hashes for cache-hit check) ----
    if (currentFiles.size > 0) {
      const allHashes = [...currentFiles].map(f => hashFromRelPath(f));
      const mPath = manifestPath();
      fs.mkdirSync(MANIFEST_DIR, { recursive: true });
      fs.writeFileSync(mPath, JSON.stringify({ hashes: allHashes }));

      const mKey = manifestKey(prefix, scope);
      try {
        await cache.saveCache([mPath], mKey);
        core.info(`Saved manifest (${allHashes.length} packages)`);
      } catch (e) {
        if (e.message && e.message.includes('already exists')) {
          core.debug('Manifest already cached for this run');
        } else {
          core.warning(`Failed to save manifest: ${e.message}`);
        }
      }
    }
  } catch (err) {
    core.warning(`vcpkg cache save failed: ${err.message}`);
  }
}

run();
