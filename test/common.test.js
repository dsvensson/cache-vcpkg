const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');
const {
  snapshotArchives,
  hashFromRelPath,
  cacheKeyFor,
  getArchivesDir,
  hashDirectory,
  computeScope,
  getVcpkgCommit,
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
describe('cacheKeyFor', () => {
  test('joins prefix and hash without scope', () => {
    expect(cacheKeyFor('vcpkg-pkg', '', 'abc123')).toBe('vcpkg-pkg-abc123');
  });

  test('includes scope when provided', () => {
    expect(cacheKeyFor('vcpkg-pkg', 'deadbeef01234567', 'abc123')).toBe(
      'vcpkg-pkg-deadbeef01234567-abc123',
    );
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
    execSync('git init', { cwd: dir, stdio: 'pipe' });
    execSync('git commit --allow-empty -m "init"', {
      cwd: dir,
      stdio: 'pipe',
      env: { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@test', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@test' },
    });
    const commit = getVcpkgCommit(dir);
    expect(commit).toMatch(/^[0-9a-f]{40}$/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
describe('computeScope', () => {
  test('returns empty string when no inputs', () => {
    expect(computeScope(null, null)).toBe('');
  });

  test('returns 16-char hex when given a git repo', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-git-'));
    execSync('git init', { cwd: dir, stdio: 'pipe' });
    execSync('git commit --allow-empty -m "init"', {
      cwd: dir,
      stdio: 'pipe',
      env: { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@test', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@test' },
    });
    const scope = computeScope(dir, null);
    expect(scope).toMatch(/^[0-9a-f]{16}$/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('changes when overlay port contents change', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-overlay-'));
    fs.mkdirSync(path.join(dir, 'my-port'));
    fs.writeFileSync(path.join(dir, 'my-port', 'portfile.cmake'), 'v1');
    const s1 = computeScope(null, dir);
    fs.writeFileSync(path.join(dir, 'my-port', 'portfile.cmake'), 'v2');
    const s2 = computeScope(null, dir);
    expect(s1).toMatch(/^[0-9a-f]{16}$/);
    expect(s2).toMatch(/^[0-9a-f]{16}$/);
    expect(s1).not.toBe(s2);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('changes when vcpkg commit changes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-commit-'));
    const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@test', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@test' };
    execSync('git init', { cwd: dir, stdio: 'pipe' });
    execSync('git commit --allow-empty -m "first"', { cwd: dir, stdio: 'pipe', env: gitEnv });
    const s1 = computeScope(dir, null);
    execSync('git commit --allow-empty -m "second"', { cwd: dir, stdio: 'pipe', env: gitEnv });
    const s2 = computeScope(dir, null);
    expect(s1).not.toBe(s2);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
