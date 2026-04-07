const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const { execSync } = require('child_process');

function getArchivesDir() {
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'vcpkg', 'archives');
  }
  const base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  return path.join(base, 'vcpkg', 'archives');
}

/**
 * Walk the archives dir and return a Set of relative paths like "ab/abcdef123…zip"
 */
function snapshotArchives(archivesDir) {
  const files = new Set();
  if (!fs.existsSync(archivesDir)) return files;

  for (const entry of fs.readdirSync(archivesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (!/^[0-9a-f]{2}$/i.test(entry.name)) continue;

    const subdirPath = path.join(archivesDir, entry.name);
    for (const file of fs.readdirSync(subdirPath)) {
      if (file.endsWith('.zip')) {
        files.add(path.join(entry.name, file));
      }
    }
  }
  return files;
}

function hashFromRelPath(relPath) {
  return path.basename(relPath, '.zip');
}

function cacheKeyFor(prefix, scope, hash) {
  const base = scope ? `${prefix}-${scope}` : prefix;
  return `${base}-${hash}`;
}

// ---------------------------------------------------------------------------
// Scope computation — scopes cache keys by vcpkg version + overlay contents
// so restore only fetches entries that match the current configuration.
// ---------------------------------------------------------------------------

function getVcpkgCommit(vcpkgRoot) {
  try {
    return execSync('git rev-parse HEAD', {
      cwd: vcpkgRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return null;
  }
}

function walkDir(dir, base, result) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const rel = base ? path.join(base, entry.name) : entry.name;
    if (entry.isDirectory()) {
      walkDir(path.join(dir, entry.name), rel, result);
    } else {
      result.push(rel);
    }
  }
}

function hashDirectory(dir) {
  const hash = crypto.createHash('sha256');
  const files = [];
  walkDir(dir, '', files);
  files.sort();
  for (const rel of files) {
    hash.update(rel);
    hash.update('\0');
    hash.update(fs.readFileSync(path.join(dir, rel)));
  }
  return hash.digest('hex');
}

/**
 * Build a 16-char hex scope string from the vcpkg commit and/or the overlay
 * ports directory contents.  Returns '' when neither input is provided.
 */
function computeScope(vcpkgRoot, overlayPorts) {
  const parts = [];

  if (vcpkgRoot) {
    const commit = getVcpkgCommit(vcpkgRoot);
    if (commit) parts.push(`vcpkg:${commit}`);
  }

  if (overlayPorts && fs.existsSync(overlayPorts)) {
    const dirHash = hashDirectory(overlayPorts);
    parts.push(`overlay:${dirHash}`);
  }

  if (parts.length === 0) return '';

  return crypto
    .createHash('sha256')
    .update(parts.join('\n'))
    .digest('hex')
    .slice(0, 16);
}

module.exports = {
  getArchivesDir,
  snapshotArchives,
  hashFromRelPath,
  cacheKeyFor,
  getVcpkgCommit,
  hashDirectory,
  computeScope,
};
