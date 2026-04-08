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
  BUILD_OK_MARKER,
} = require('./common');

const CONCURRENCY = 10;

function findInstalledDir() {
  const input = core.getInput('installed-dir');
  if (input) {
    const statusPath = path.join(input, 'vcpkg', 'status');
    if (fs.existsSync(statusPath)) return input;
    core.debug(`installed-dir input set to "${input}" but ${statusPath} not found`);
  }

  // Check VCPKG_INSTALLED_DIR env var (set by cmake presets, --x-install-root, etc.)
  const envDir = process.env.VCPKG_INSTALLED_DIR;
  if (envDir) {
    const statusPath = path.join(envDir, 'vcpkg', 'status');
    if (fs.existsSync(statusPath)) return envDir;
    core.debug(`VCPKG_INSTALLED_DIR="${envDir}" but ${statusPath} not found`);
  }

  const workspace = process.env.GITHUB_WORKSPACE || process.cwd();
  const candidate = path.join(workspace, 'vcpkg_installed');
  if (fs.existsSync(path.join(candidate, 'vcpkg', 'status'))) return candidate;

  // Dump what we can see to help diagnose
  core.info('Could not find vcpkg status database for port name resolution');
  for (const base of [
    input,
    envDir,
    path.join(workspace, 'vcpkg_installed'),
    process.env.RUNNER_TEMP && path.join(process.env.RUNNER_TEMP, 'vcpkg_installed'),
  ].filter(Boolean)) {
    if (fs.existsSync(base)) {
      core.startGroup(`Directory listing: ${base}`);
      try {
        listDirShallow(base);
      } catch { /* ignore */ }
      core.endGroup();
    }
  }
  return null;
}

function listDirShallow(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    core.info(entry.isDirectory() ? `${entry.name}/` : entry.name);
    if (entry.isDirectory()) {
      try {
        for (const sub of fs.readdirSync(path.join(dir, entry.name), { withFileTypes: true })) {
          core.info(`  ${sub.isDirectory() ? sub.name + '/' : sub.name}`);
        }
      } catch { /* ignore */ }
    }
  }
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

    // ---- Save manifest only after a confirmed fully-successful build ----
    // The manifest drives cache-hit — saving it after a partial failure
    // would cause the next run to skip the build, leaving broken packages
    // uncached.
    //
    // Success is signalled by the marker file at $VCPKG_CACHE_COMPLETE:
    //   - The `run` input creates it automatically on exit code 0
    //   - Without `run`, the workflow touches it:  touch "$VCPKG_CACHE_COMPLETE"
    //   - Builder cache-hit (skip path) creates it because the old manifest is valid
    const buildOk = fs.existsSync(BUILD_OK_MARKER);
    if (buildOk && currentFiles.size > 0) {
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
