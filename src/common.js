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

/**
 * Extract the 64-char ABI hash from the tail of a cache key.
 * Works for both named ("…-sdl3-<hash>") and unnamed ("…-<hash>") formats.
 */
function hashFromCacheKey(key) {
  const m = key.match(/([0-9a-f]{64})$/);
  return m ? m[1] : null;
}

/**
 * Build a cache key.  portName is optional — omit or pass '' to skip it.
 */
function cacheKeyFor(prefix, scope, portName, hash) {
  let base = scope ? `${prefix}-${scope}` : prefix;
  if (portName) base += `-${portName}`;
  return `${base}-${hash}`;
}

// ---------------------------------------------------------------------------
// Scope computation
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
 * Build an 8-char hex scope from the vcpkg commit, overlay contents, and
 * an optional user-supplied key string.
 * Returns '' when no inputs are provided.
 */
function computeScope(vcpkgRoot, overlayPorts, extraKey) {
  const parts = [];

  if (vcpkgRoot) {
    const commit = getVcpkgCommit(vcpkgRoot);
    if (commit) parts.push(`vcpkg:${commit}`);
  }

  if (overlayPorts && fs.existsSync(overlayPorts)) {
    const dirHash = hashDirectory(overlayPorts);
    parts.push(`overlay:${dirHash}`);
  }

  if (extraKey) parts.push(`key:${extraKey}`);

  if (parts.length === 0) return '';

  return crypto
    .createHash('sha256')
    .update(parts.join('\n'))
    .digest('hex')
    .slice(0, 8);
}

// ---------------------------------------------------------------------------
// Manifest — records the set of ABI hashes from the last successful build.
// Used to determine cache-hit without restoring every package.
// ---------------------------------------------------------------------------

const MANIFEST_DIR = path.join(os.tmpdir(), 'vcpkg-cache-meta');

function manifestPath() {
  return path.join(MANIFEST_DIR, 'manifest.json');
}

function manifestKey(prefix, scope) {
  const runId = process.env.GITHUB_RUN_ID || 'local';
  const attempt = process.env.GITHUB_RUN_ATTEMPT || '1';
  return `${prefix}-manifest-${scope}-${runId}-${attempt}`;
}

function manifestRestoreKey(prefix, scope) {
  return `${prefix}-manifest-${scope}-`;
}

// ---------------------------------------------------------------------------
// Port-name resolution from vcpkg's installed status database
// ---------------------------------------------------------------------------

/**
 * Parse vcpkg's DPKG-style status file and return a Map<abiHash, portName>.
 * @param {string} installedDir  Path to vcpkg_installed (contains vcpkg/status)
 */
function parseVcpkgStatus(installedDir) {
  const abiToPort = new Map();
  const statusPath = path.join(installedDir, 'vcpkg', 'status');

  if (!fs.existsSync(statusPath)) return abiToPort;

  const content = fs.readFileSync(statusPath, 'utf-8');
  for (const para of content.split(/\n\n+/)) {
    let pkg = null;
    let abi = null;
    let installed = false;

    for (const line of para.split('\n')) {
      if (line.startsWith('Package: ')) pkg = line.slice(9).trim();
      else if (line.startsWith('Abi: ')) abi = line.slice(5).trim();
      else if (line === 'Status: install ok installed')
        installed = true;
    }

    if (pkg && abi && installed) abiToPort.set(abi, pkg);
  }

  return abiToPort;
}

module.exports = {
  getArchivesDir,
  snapshotArchives,
  hashFromRelPath,
  hashFromCacheKey,
  cacheKeyFor,
  getVcpkgCommit,
  hashDirectory,
  computeScope,
  manifestPath,
  manifestKey,
  manifestRestoreKey,
  MANIFEST_DIR,
  parseVcpkgStatus,
};
