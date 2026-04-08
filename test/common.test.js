const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');
const {
  snapshotArchives,
  hashFromRelPath,
  hashFromCacheKey,
  cacheKeyFor,
  getArchivesDir,
  hashDirectory,
  computeScope,
  getVcpkgCommit,
  parseVcpkgStatus,
} = require('../src/common');

// ---------------------------------------------------------------------------
describe('getArchivesDir', () => {
  const origXDG = process.env.XDG_CACHE_HOME;
  afterEach(() => {
    if (origXDG === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = origXDG;
  });

  test('returns path ending with vcpkg/archives', () => {
    expect(getArchivesDir()).toMatch(/vcpkg[\\/]archives$/);
  });

  if (process.platform !== 'win32') {
    test('respects XDG_CACHE_HOME', () => {
      process.env.XDG_CACHE_HOME = '/custom/cache';
      expect(getArchivesDir()).toBe('/custom/cache/vcpkg/archives');
    });

    test('falls back to ~/.cache when XDG_CACHE_HOME is unset', () => {
      delete process.env.XDG_CACHE_HOME;
      expect(getArchivesDir()).toBe(
        path.join(os.homedir(), '.cache', 'vcpkg', 'archives'),
      );
    });
  }
});

// ---------------------------------------------------------------------------
describe('hashFromRelPath', () => {
  test('extracts hash from relative path', () => {
    const hash = 'a'.repeat(64);
    expect(hashFromRelPath(path.join('aa', `${hash}.zip`))).toBe(hash);
  });
});

// ---------------------------------------------------------------------------
describe('hashFromCacheKey', () => {
  const hash = 'ab' + 'cd'.repeat(31);

  test('extracts hash from unnamed key', () => {
    expect(hashFromCacheKey(`vcpkg-pkg-${hash}`)).toBe(hash);
  });

  test('extracts hash from scoped unnamed key', () => {
    expect(hashFromCacheKey(`vcpkg-pkg-a1b2c3d4-${hash}`)).toBe(hash);
  });

  test('extracts hash from named key', () => {
    expect(hashFromCacheKey(`vcpkg-pkg-a1b2c3d4-sdl3-${hash}`)).toBe(hash);
  });

  test('extracts hash from key with hyphenated port name', () => {
    expect(
      hashFromCacheKey(`vcpkg-pkg-a1b2c3d4-vcpkg-cmake-config-${hash}`),
    ).toBe(hash);
  });

  test('returns null for malformed key', () => {
    expect(hashFromCacheKey('vcpkg-pkg-tooshort')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe('cacheKeyFor', () => {
  const hash = 'f'.repeat(64);

  test('prefix + hash only (no scope, no name)', () => {
    expect(cacheKeyFor('vcpkg-pkg', '', '', hash)).toBe(`vcpkg-pkg-${hash}`);
  });

  test('prefix + scope + hash (no name)', () => {
    expect(cacheKeyFor('vcpkg-pkg', 'a1b2c3d4', '', hash)).toBe(
      `vcpkg-pkg-a1b2c3d4-${hash}`,
    );
  });

  test('prefix + scope + name + hash', () => {
    expect(cacheKeyFor('vcpkg-pkg', 'a1b2c3d4', 'sdl3', hash)).toBe(
      `vcpkg-pkg-a1b2c3d4-sdl3-${hash}`,
    );
  });

  test('prefix + scope + hyphenated name + hash', () => {
    expect(
      cacheKeyFor('vcpkg-pkg', 'a1b2c3d4', 'vcpkg-cmake-config', hash),
    ).toBe(`vcpkg-pkg-a1b2c3d4-vcpkg-cmake-config-${hash}`);
  });
});

// ---------------------------------------------------------------------------
describe('snapshotArchives', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-test-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('returns empty set for empty directory', () => {
    expect(snapshotArchives(tmpDir).size).toBe(0);
  });

  test('returns empty set for non-existent directory', () => {
    expect(snapshotArchives('/no/such/path').size).toBe(0);
  });

  test('finds zip files in two-char hex subdirectories', () => {
    const hash = 'ab' + 'c'.repeat(62);
    fs.mkdirSync(path.join(tmpDir, 'ab'));
    fs.writeFileSync(path.join(tmpDir, 'ab', `${hash}.zip`), '');

    const snap = snapshotArchives(tmpDir);
    expect(snap.size).toBe(1);
    expect(snap.has(path.join('ab', `${hash}.zip`))).toBe(true);
  });

  test('finds files across multiple subdirectories', () => {
    for (const sub of ['00', '0f', 'ff']) {
      const hash = sub + 'd'.repeat(62);
      fs.mkdirSync(path.join(tmpDir, sub));
      fs.writeFileSync(path.join(tmpDir, sub, `${hash}.zip`), '');
    }
    expect(snapshotArchives(tmpDir).size).toBe(3);
  });

  test('ignores non-zip files', () => {
    fs.mkdirSync(path.join(tmpDir, 'ab'));
    fs.writeFileSync(path.join(tmpDir, 'ab', 'something.txt'), '');
    fs.writeFileSync(path.join(tmpDir, 'ab', 'hash.zip.lock'), '');
    expect(snapshotArchives(tmpDir).size).toBe(0);
  });

  test('ignores subdirectories that are not two-char hex', () => {
    for (const bad of ['zz', 'abc', '0', 'GG']) {
      fs.mkdirSync(path.join(tmpDir, bad));
      fs.writeFileSync(path.join(tmpDir, bad, 'file.zip'), '');
    }
    expect(snapshotArchives(tmpDir).size).toBe(0);
  });

  test('ignores zip files directly in root', () => {
    fs.writeFileSync(path.join(tmpDir, 'loose.zip'), '');
    expect(snapshotArchives(tmpDir).size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('hashDirectory', () => {
  let tmpDir;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hashdir-test-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('produces consistent hash for same contents', () => {
    fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'hello');
    expect(hashDirectory(tmpDir)).toBe(hashDirectory(tmpDir));
  });

  test('changes when file contents change', () => {
    fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'v1');
    const h1 = hashDirectory(tmpDir);
    fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'v2');
    const h2 = hashDirectory(tmpDir);
    expect(h1).not.toBe(h2);
  });

  test('changes when a file is added', () => {
    fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'hello');
    const h1 = hashDirectory(tmpDir);
    fs.writeFileSync(path.join(tmpDir, 'b.txt'), 'world');
    const h2 = hashDirectory(tmpDir);
    expect(h1).not.toBe(h2);
  });

  test('walks subdirectories', () => {
    fs.mkdirSync(path.join(tmpDir, 'sub'));
    fs.writeFileSync(path.join(tmpDir, 'sub', 'deep.txt'), 'nested');
    const h = hashDirectory(tmpDir);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  test('skips .git directories', () => {
    fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'stable');
    const h1 = hashDirectory(tmpDir);
    fs.mkdirSync(path.join(tmpDir, '.git'));
    fs.writeFileSync(path.join(tmpDir, '.git', 'noise'), 'ignore me');
    const h2 = hashDirectory(tmpDir);
    expect(h1).toBe(h2);
  });
});

// ---------------------------------------------------------------------------
describe('getVcpkgCommit', () => {
  test('returns null for non-git directory', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novcs-'));
    expect(getVcpkgCommit(dir)).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('reads HEAD from a git repo', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitrepo-'));
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@test',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@test',
    };
    execSync('git init', { cwd: dir, stdio: 'pipe' });
    execSync('git commit --allow-empty -m "init"', {
      cwd: dir,
      stdio: 'pipe',
      env,
    });
    const commit = getVcpkgCommit(dir);
    expect(commit).toMatch(/^[0-9a-f]{40}$/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
describe('computeScope', () => {
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'test',
    GIT_AUTHOR_EMAIL: 'test@test',
    GIT_COMMITTER_NAME: 'test',
    GIT_COMMITTER_EMAIL: 'test@test',
  };

  test('returns empty string when no inputs', () => {
    expect(computeScope(null, null, null)).toBe('');
  });

  test('returns 8-char hex when given a git repo', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-git-'));
    execSync('git init', { cwd: dir, stdio: 'pipe' });
    execSync('git commit --allow-empty -m "init"', {
      cwd: dir,
      stdio: 'pipe',
      env: gitEnv,
    });
    const scope = computeScope(dir, null);
    expect(scope).toMatch(/^[0-9a-f]{8}$/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('changes when overlay port contents change', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-overlay-'));
    fs.mkdirSync(path.join(dir, 'my-port'));
    fs.writeFileSync(path.join(dir, 'my-port', 'portfile.cmake'), 'v1');
    const s1 = computeScope(null, dir);
    fs.writeFileSync(path.join(dir, 'my-port', 'portfile.cmake'), 'v2');
    const s2 = computeScope(null, dir);
    expect(s1).toMatch(/^[0-9a-f]{8}$/);
    expect(s2).toMatch(/^[0-9a-f]{8}$/);
    expect(s1).not.toBe(s2);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('changes when vcpkg commit changes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-commit-'));
    execSync('git init', { cwd: dir, stdio: 'pipe' });
    execSync('git commit --allow-empty -m "first"', {
      cwd: dir,
      stdio: 'pipe',
      env: gitEnv,
    });
    const s1 = computeScope(dir, null);
    execSync('git commit --allow-empty -m "second"', {
      cwd: dir,
      stdio: 'pipe',
      env: gitEnv,
    });
    const s2 = computeScope(dir, null);
    expect(s1).not.toBe(s2);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('changes when extra key changes', () => {
    const s1 = computeScope(null, null, 'llvm-19');
    const s2 = computeScope(null, null, 'llvm-20');
    expect(s1).toMatch(/^[0-9a-f]{8}$/);
    expect(s2).toMatch(/^[0-9a-f]{8}$/);
    expect(s1).not.toBe(s2);
  });

  test('extra key supports multiline', () => {
    const single = computeScope(null, null, 'llvm-20\ndeps-foo bar');
    const different = computeScope(null, null, 'llvm-20\ndeps-foo baz');
    expect(single).toMatch(/^[0-9a-f]{8}$/);
    expect(single).not.toBe(different);
  });

  test('mixes extra key with vcpkg commit', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-mixed-'));
    execSync('git init', { cwd: dir, stdio: 'pipe' });
    execSync('git commit --allow-empty -m "init"', {
      cwd: dir,
      stdio: 'pipe',
      env: gitEnv,
    });
    const withKey = computeScope(dir, null, 'llvm-20');
    const withoutKey = computeScope(dir, null);
    expect(withKey).not.toBe(withoutKey);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
describe('parseVcpkgStatus', () => {
  let tmpDir;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-test-'));
    fs.mkdirSync(path.join(tmpDir, 'vcpkg'), { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('returns empty map when status file does not exist', () => {
    expect(parseVcpkgStatus(tmpDir).size).toBe(0);
  });

  test('parses package entries with Abi field', () => {
    const hash1 = 'a'.repeat(64);
    const hash2 = 'b'.repeat(64);
    fs.writeFileSync(
      path.join(tmpDir, 'vcpkg', 'status'),
      [
        `Package: sdl3`,
        `Version: 3.2.0`,
        `Architecture: x64-linux`,
        `Multi-Arch: same`,
        `Abi: ${hash1}`,
        `Type: Port`,
        `Status: install ok installed`,
        ``,
        `Package: vcpkg-cmake`,
        `Version: 2024-04-18`,
        `Architecture: x64-linux`,
        `Multi-Arch: same`,
        `Abi: ${hash2}`,
        `Type: Port`,
        `Status: install ok installed`,
      ].join('\n'),
    );

    const map = parseVcpkgStatus(tmpDir);
    expect(map.size).toBe(2);
    expect(map.get(hash1)).toBe('sdl3');
    expect(map.get(hash2)).toBe('vcpkg-cmake');
  });

  test('skips feature entries (no Abi field)', () => {
    const hash = 'c'.repeat(64);
    fs.writeFileSync(
      path.join(tmpDir, 'vcpkg', 'status'),
      [
        `Package: sdl3`,
        `Version: 3.2.0`,
        `Abi: ${hash}`,
        `Status: install ok installed`,
        ``,
        `Package: sdl3`,
        `Feature: vulkan`,
        `Architecture: x64-linux`,
        `Status: install ok installed`,
      ].join('\n'),
    );

    const map = parseVcpkgStatus(tmpDir);
    expect(map.size).toBe(1);
    expect(map.get(hash)).toBe('sdl3');
  });

  test('skips entries that are not installed', () => {
    const hash = 'd'.repeat(64);
    fs.writeFileSync(
      path.join(tmpDir, 'vcpkg', 'status'),
      [
        `Package: old-pkg`,
        `Abi: ${hash}`,
        `Status: purge ok not-installed`,
      ].join('\n'),
    );

    expect(parseVcpkgStatus(tmpDir).size).toBe(0);
  });
});
