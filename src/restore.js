const core = require('@actions/core');
const cache = require('@actions/cache');
const { spawn } = require('child_process');
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
  BUILD_OK_MARKER,
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

/**
 * Spawn a command, stream output in real-time, and on failure dump any
 * log files referenced in the output as collapsible groups.
 * Returns true on success, false on failure (after calling core.setFailed).
 */
function executeCommand(cmd) {
  return new Promise(resolve => {
    core.info(`Running: ${cmd}`);
    const child = spawn(cmd, {
      shell: true,
      stdio: ['inherit', 'pipe', 'pipe'],
      cwd: process.env.GITHUB_WORKSPACE || process.cwd(),
      env: process.env,
    });

    let output = '';
    child.stdout.on('data', data => {
      process.stdout.write(data);
      output += data.toString();
    });
    child.stderr.on('data', data => {
      process.stderr.write(data);
      output += data.toString();
    });

    child.on('error', err => {
      core.setFailed(`Failed to start command: ${err.message}`);
      resolve(false);
    });

    child.on('close', code => {
      if (code === 0) {
        resolve(true);
        return;
      }

      // Extract log file paths referenced in vcpkg error output
      const logPaths = new Set();
      for (const line of output.split('\n')) {
        const m = line.match(
          /^\s+((?:\/|[A-Za-z]:[/\\])\S+\.log)\s*$/,
        );
        if (m) logPaths.add(m[1]);
      }

      for (const logPath of logPaths) {
        try {
          const content = fs.readFileSync(logPath, 'utf-8');
          core.startGroup(`Build log: ${logPath}`);
          core.info(content);
          core.endGroup();
        } catch {
          core.warning(`Could not read log file: ${logPath}`);
        }
      }

      core.setFailed(`Command failed with exit code ${code}: ${cmd}`);
      resolve(false);
    });
  });
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

    // ---- Restore packages (skipped for builder when cache is complete) ----
    const skipRestore = cacheHit && saveCache;

    if (skipRestore) {
      core.info('Skipping restore — cache is complete');
    } else {
      let restored = 0;
      await core.group(
        `Restoring ${tasks.length} cached packages (scope: ${scope || 'none'})`,
        async () => {
          for (let i = 0; i < tasks.length; i += CONCURRENCY) {
            const batch = tasks.slice(i, i + CONCURRENCY);
            const results = await Promise.allSettled(
              batch.map(async ({ key, hash }) => {
                const subdir = hash.slice(0, 2);
                const zipPath = path.join(
                  archivesDir,
                  subdir,
                  `${hash}.zip`,
                );
                fs.mkdirSync(path.join(archivesDir, subdir), {
                  recursive: true,
                });

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
                core.warning(
                  `Restore failed: ${r.reason?.message || r.reason}`,
                );
              }
            }
          }
        },
      );
      core.info(`Restored ${restored} / ${tasks.length} packages`);
    }

    // ---- Save state for post step ----
    if (saveCache && !skipRestore) {
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

    // Export marker path so the workflow can signal build success:
    //   touch "$VCPKG_CACHE_COMPLETE"
    // The post step only saves the manifest if this file exists.
    fs.mkdirSync(MANIFEST_DIR, { recursive: true });
    core.exportVariable('VCPKG_CACHE_COMPLETE', BUILD_OK_MARKER);

    // ---- Run command if specified ----
    const runCmd = core.getInput('run');
    if (runCmd) {
      if (skipRestore) {
        core.info('Skipping run — cache is complete');
        fs.writeFileSync(BUILD_OK_MARKER, '');
      } else {
        const ok = await executeCommand(runCmd);
        if (ok) fs.writeFileSync(BUILD_OK_MARKER, '');
      }
    }

    // When cache-hit skipped the build entirely, the previous
    // manifest is still valid — mark as ok so it gets refreshed.
    if (skipRestore && !runCmd) {
      fs.writeFileSync(BUILD_OK_MARKER, '');
    }
  } catch (err) {
    // Never fail the build for cache issues
    core.warning(`vcpkg cache restore failed: ${err.message}`);
  }
}

run();
