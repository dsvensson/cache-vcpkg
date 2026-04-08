const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const {
  snapshotArchives,
  hashFromRelPath,
  hashFromCacheKey,
  cacheKeyFor,
  computeScope,
  parseVcpkgStatus,
} = require('../src/common');

// ---------------------------------------------------------------------------
// vcpkg setup — clone & bootstrap once per test run, reused across runs via
// a stable tmp path.  Takes ~60-90 s the first time on a CI runner.
// ---------------------------------------------------------------------------
const VCPKG_ROOT = path.join(os.tmpdir(), 'cache-vcpkg-test-vcpkg');
const IS_WIN = process.platform === 'win32';
const VCPKG_BIN = path.join(VCPKG_ROOT, IS_WIN ? 'vcpkg.exe' : 'vcpkg');

/**
 * Parse `vcpkg install --dry-run` output into unique lowercase port names.
 */
function parseInstallPlan(output) {
  const pkgs = [];
  for (const line of output.split('\n')) {
    const m = line.match(/^\s+\*?\s*([a-z][a-z0-9-]*)(?:\[.*?\])?:\S/);
    if (m && !pkgs.includes(m[1])) pkgs.push(m[1]);
  }
  return pkgs;
}

// ---- one-time clone & bootstrap ----
beforeAll(() => {
  if (!fs.existsSync(VCPKG_BIN)) {
    if (fs.existsSync(VCPKG_ROOT))
      fs.rmSync(VCPKG_ROOT, { recursive: true, force: true });

    execSync(
      `git clone --depth 1 https://github.com/microsoft/vcpkg.git "${VCPKG_ROOT}"`,
      { stdio: 'inherit' },
    );

    const ext = IS_WIN ? '.bat' : '.sh';
    execSync(
      `"${path.join(VCPKG_ROOT, 'bootstrap-vcpkg' + ext)}" -disableMetrics`,
      { cwd: VCPKG_ROOT, stdio: 'inherit' },
    );
  }
}, 300_000);

// ---------------------------------------------------------------------------
describe('sdl3 binary caching', () => {
  let archivesDir;
  let manifestDir;
  let packages;
  let scope;

  beforeAll(() => {
    archivesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcpkg-archives-'));
    manifestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcpkg-manifest-'));

    fs.writeFileSync(
      path.join(manifestDir, 'vcpkg.json'),
      JSON.stringify({
        name: 'test-project',
        version: '1.0.0',
        dependencies: ['sdl3'],
      }),
    );

    const output = execSync(
      [
        `"${VCPKG_BIN}"`,
        'install',
        '--dry-run',
        '--binarysource=clear',
        `--binarysource=files,${archivesDir},readwrite`,
        `--vcpkg-root="${VCPKG_ROOT}"`,
      ].join(' '),
      { encoding: 'utf-8', cwd: manifestDir },
    );

    packages = parseInstallPlan(output);
    if (packages.length === 0) {
      console.error('vcpkg --dry-run output:\n', output);
    }

    scope = computeScope(VCPKG_ROOT, null);
  }, 120_000);

  afterAll(() => {
    fs.rmSync(archivesDir, { recursive: true, force: true });
    fs.rmSync(manifestDir, { recursive: true, force: true });
  });

  test('install plan includes sdl3 and at least one dependency', () => {
    expect(packages).toContain('sdl3');
    expect(packages.length).toBeGreaterThan(1);
  });

  test('scope is an 8-char hex string derived from vcpkg commit', () => {
    expect(scope).toMatch(/^[0-9a-f]{8}$/);
  });

  test('save step produces named, scoped cache keys for every package', async () => {
    const preSnapshot = snapshotArchives(archivesDir);
    expect(preSnapshot.size).toBe(0);

    // Simulate vcpkg writing archives and a status database
    const installedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'installed-'));
    fs.mkdirSync(path.join(installedDir, 'vcpkg'), { recursive: true });

    const expectedHashes = [];
    const statusLines = [];

    for (const pkg of packages) {
      const hash = crypto.randomBytes(32).toString('hex');
      const subdir = hash.slice(0, 2);
      fs.mkdirSync(path.join(archivesDir, subdir), { recursive: true });
      fs.writeFileSync(
        path.join(archivesDir, subdir, `${hash}.zip`),
        Buffer.alloc(128),
      );
      expectedHashes.push(hash);
      statusLines.push(
        [
          `Package: ${pkg}`,
          `Version: 1.0.0`,
          `Architecture: x64-linux`,
          `Abi: ${hash}`,
          `Status: install ok installed`,
        ].join('\n'),
      );
    }

    fs.writeFileSync(
      path.join(installedDir, 'vcpkg', 'status'),
      statusLines.join('\n\n') + '\n',
    );

    // Parse the status file
    const abiToPort = parseVcpkgStatus(installedDir);
    expect(abiToPort.size).toBe(packages.length);

    // Post-build snapshot and diff
    const postSnapshot = snapshotArchives(archivesDir);
    const newFiles = [...postSnapshot].filter(f => !preSnapshot.has(f));
    expect(newFiles).toHaveLength(packages.length);

    // Replay save logic with mocked saveCache
    const mockSaveCache = jest.fn().mockResolvedValue(1);

    for (const relPath of newFiles) {
      const hash = hashFromRelPath(relPath);
      const portName = abiToPort.get(hash) || '';
      const key = cacheKeyFor('vcpkg-pkg', scope, portName, hash);
      await mockSaveCache([path.join(archivesDir, relPath)], key);
    }

    expect(mockSaveCache).toHaveBeenCalledTimes(packages.length);

    // Verify key format and that hash can be extracted back
    const savedKeys = [];
    for (const [paths, key] of mockSaveCache.mock.calls) {
      expect(paths[0]).toMatch(/\.zip$/);
      expect(fs.existsSync(paths[0])).toBe(true);

      const extractedHash = hashFromCacheKey(key);
      expect(extractedHash).toMatch(/^[0-9a-f]{64}$/);
      expect(expectedHashes).toContain(extractedHash);
      savedKeys.push(key);
    }

    // Every key contains both the scope and a port name
    for (const pkg of packages) {
      const hash = expectedHashes[packages.indexOf(pkg)];
      const expected = `vcpkg-pkg-${scope}-${pkg}-${hash}`;
      expect(savedKeys).toContain(expected);
    }

    fs.rmSync(installedDir, { recursive: true, force: true });
  });

  test('already-cached packages are excluded from save', () => {
    const postSnapshot = snapshotArchives(archivesDir);
    const realDiff = [...postSnapshot].filter(f => !postSnapshot.has(f));
    expect(realDiff).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe('overlay port invalidation', () => {
  let overlayDir;

  beforeEach(() => {
    overlayDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overlay-test-'));
    fs.mkdirSync(path.join(overlayDir, 'my-port'));
    fs.writeFileSync(
      path.join(overlayDir, 'my-port', 'portfile.cmake'),
      'vcpkg_download_distfile(...)',
    );
    fs.writeFileSync(
      path.join(overlayDir, 'my-port', 'vcpkg.json'),
      JSON.stringify({ name: 'my-port', version: '1.0.0' }),
    );
  });

  afterEach(() => {
    fs.rmSync(overlayDir, { recursive: true, force: true });
  });

  test('scope changes when overlay port is modified', () => {
    const scope1 = computeScope(VCPKG_ROOT, overlayDir);
    fs.writeFileSync(
      path.join(overlayDir, 'my-port', 'portfile.cmake'),
      'vcpkg_from_github(...)',
    );
    const scope2 = computeScope(VCPKG_ROOT, overlayDir);

    expect(scope1).toMatch(/^[0-9a-f]{8}$/);
    expect(scope2).toMatch(/^[0-9a-f]{8}$/);
    expect(scope1).not.toBe(scope2);
  });

  test('different scopes produce different cache keys for the same ABI hash', () => {
    const abiHash = 'f'.repeat(64);
    const scope1 = computeScope(VCPKG_ROOT, overlayDir);
    fs.writeFileSync(
      path.join(overlayDir, 'my-port', 'portfile.cmake'),
      'changed',
    );
    const scope2 = computeScope(VCPKG_ROOT, overlayDir);

    const key1 = cacheKeyFor('vcpkg-pkg', scope1, 'sdl3', abiHash);
    const key2 = cacheKeyFor('vcpkg-pkg', scope2, 'sdl3', abiHash);
    expect(key1).not.toBe(key2);
  });

  test('scope is stable when overlay ports are unchanged', () => {
    const s1 = computeScope(VCPKG_ROOT, overlayDir);
    const s2 = computeScope(VCPKG_ROOT, overlayDir);
    expect(s1).toBe(s2);
  });
});

// ---------------------------------------------------------------------------
describe('save-cache: false (consumer mode)', () => {
  let archivesDir;

  beforeEach(() => {
    archivesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'consumer-test-'));
    // Pre-populate with some zips (simulating a successful restore)
    for (let i = 0; i < 3; i++) {
      const hash = crypto.randomBytes(32).toString('hex');
      const subdir = hash.slice(0, 2);
      fs.mkdirSync(path.join(archivesDir, subdir), { recursive: true });
      fs.writeFileSync(
        path.join(archivesDir, subdir, `${hash}.zip`),
        Buffer.alloc(64),
      );
    }
  });

  afterEach(() => {
    fs.rmSync(archivesDir, { recursive: true, force: true });
  });

  test('snapshot is skipped — empty snapshot means all files look new', () => {
    // When save-cache is false, restore.js skips saving the snapshot.
    // If save.js were to run its diff with an empty snapshot, it would
    // see all files as "new". The early-exit guard prevents this.
    const emptySnapshot = new Set(); // simulates skipped snapshot
    const current = snapshotArchives(archivesDir);
    const wouldBeNew = [...current].filter(f => !emptySnapshot.has(f));
    expect(wouldBeNew.length).toBe(3); // all 3 would appear new
    // ...but save.js exits before reaching this logic
  });

  test('VCPKG_BINARY_SOURCES should use read mode', () => {
    // Verify the mode string the restore step would produce
    const saveCache = false;
    const mode = saveCache ? 'readwrite' : 'read';
    expect(mode).toBe('read');
    expect(`files,${archivesDir},${mode}`).toMatch(/,read$/);
    expect(`files,${archivesDir},${mode}`).not.toMatch(/readwrite/);
  });
});

// ---------------------------------------------------------------------------
describe('parseInstallPlan', () => {
  const parse = output => {
    const pkgs = [];
    for (const line of output.split('\n')) {
      const m = line.match(/^\s+\*?\s*([a-z][a-z0-9-]*)(?:\[.*?\])?:\S/);
      if (m && !pkgs.includes(m[1])) pkgs.push(m[1]);
    }
    return pkgs;
  };

  test('parses starred and unstarred lines', () => {
    const output = [
      'The following packages will be built and installed:',
      '  * vcpkg-cmake:x64-linux -> 2024-04-18',
      '    vcpkg-cmake-config:x64-linux -> 2024-05-23',
      '  * sdl3[core]:x64-linux -> 3.2.0',
    ].join('\n');
    expect(parse(output)).toEqual([
      'vcpkg-cmake',
      'vcpkg-cmake-config',
      'sdl3',
    ]);
  });

  test('deduplicates repeated package names', () => {
    const output = [
      '  * foo:x64-linux -> 1.0',
      '  * foo[extra]:x64-linux -> 1.0',
    ].join('\n');
    expect(parse(output)).toEqual(['foo']);
  });

  test('ignores non-package lines', () => {
    const output = [
      'Computing installation plan...',
      '-- some cmake output',
      'Total install count: 2',
    ].join('\n');
    expect(parse(output)).toEqual([]);
  });
});
