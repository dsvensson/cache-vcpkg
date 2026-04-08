# vcpkg Binary Cache

Per-package binary caching for [vcpkg](https://vcpkg.io) using the GitHub Actions cache.
Each vcpkg package is stored as its own cache entry, keyed by the ABI hash that vcpkg produces.
Packages are restored and saved individually — no monolithic tarball, no wasted rebuilds.

## How it works

The action does **not** pre-compute ABI hashes.
It lets vcpkg do what it already does, and caches the results.

1. **Restore** (runs at action step) — lists existing cache entries via the GitHub API,
   restores each zip into `~/.cache/vcpkg/archives/<hash[0:2]>/<hash>.zip`,
   and exports `VCPKG_BINARY_SOURCES` so vcpkg reads from that directory.
2. **Build** — vcpkg runs normally.
   It finds cache hits in the archives dir and writes new zips for anything it builds.
3. **Save** (post step) — diffs the archives dir against the pre-build snapshot
   and uploads every new zip as an individual cache entry.

Cache keys are scoped by vcpkg commit and overlay port contents (when configured)
so updating either factor automatically invalidates stale entries.

## Usage

### Basic

```yaml
steps:
  - uses: actions/checkout@v4

  - uses: your-org/cache-vcpkg@v1

  - run: vcpkg install
```

The action exports `VCPKG_BINARY_SOURCES` automatically.
vcpkg picks it up — no extra flags needed.

### With vcpkg submodule and overlay ports

```yaml
steps:
  - uses: actions/checkout@v4
    with:
      submodules: true

  - uses: your-org/cache-vcpkg@v1
    with:
      vcpkg-root: vcpkg
      overlay-ports: ports

  - run: >
      ./vcpkg/vcpkg install
      --overlay-ports=ports
```

When `vcpkg-root` is set, the cache is scoped to the vcpkg commit hash.
Bumping the vcpkg submodule invalidates all cached packages.

When `overlay-ports` is set, the cache is also scoped to a content hash
of that directory. Editing any overlay port file invalidates the cache
so overlay packages (and their dependents) are rebuilt.

### Multi-job workflow (builder + consumers)

Use a dedicated builder job to populate the cache, then consumer jobs
restore from it. The builder checks `cache-hit` to skip the toolchain
install and vcpkg build entirely when nothing has changed.

```yaml
env:
  LLVM_VERSION: "20"
  PACKAGES: "build-essential libx11-dev libwayland-dev"

jobs:
  vcpkg-cache:
    runs-on: ubuntu-latest
    outputs:
      cache-hit: ${{ steps.cache.outputs.cache-hit }}
    steps:
      - uses: actions/checkout@v6
        with:
          submodules: true
      - uses: your-org/cache-vcpkg@v1
        id: cache
        with:
          vcpkg-root: vcpkg
          key: |
            llvm-${{ env.LLVM_VERSION }}
            deps-${{ env.PACKAGES }}
      # Everything below only runs on cache miss
      - if: steps.cache.outputs.cache-hit != 'true'
        run: apt-get install -y $PACKAGES
      - if: steps.cache.outputs.cache-hit != 'true'
        run: ./vcpkg/vcpkg install

  build-target-a:
    needs: vcpkg-cache
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
        with:
          submodules: true
      - uses: your-org/cache-vcpkg@v1
        with:
          vcpkg-root: vcpkg
          save-cache: false
          key: |
            llvm-${{ env.LLVM_VERSION }}
            deps-${{ env.PACKAGES }}
      - run: cmake --preset target-a && cmake --build --preset target-a

  build-target-b:
    needs: vcpkg-cache
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
        with:
          submodules: true
      - uses: your-org/cache-vcpkg@v1
        with:
          vcpkg-root: vcpkg
          save-cache: false
          key: |
            llvm-${{ env.LLVM_VERSION }}
            deps-${{ env.PACKAGES }}
      - run: cmake --preset target-b && cmake --build --preset target-b
```

On cache hit, the builder does nothing beyond two cheap API calls (manifest
check + cache key listing). Consumer jobs restore the packages and set
`VCPKG_BINARY_SOURCES` to read-only.

The `key` input is mixed into the cache scope — changing LLVM version or
system packages invalidates the cache, forcing a rebuild.

### CMake preset workflow

```yaml
steps:
  - uses: actions/checkout@v4
    with:
      submodules: true

  - uses: your-org/cache-vcpkg@v1
    with:
      vcpkg-root: vcpkg

  - run: cmake --preset release

  - run: cmake --build --preset release
```

If your `CMakePresets.json` already sets `VCPKG_INSTALLED_DIR` and
the vcpkg toolchain file, the action's exported `VCPKG_BINARY_SOURCES`
is all that is needed for caching to work.

## Inputs

| Name | Default | Description |
|------|---------|-------------|
| `token` | `${{ github.token }}` | GitHub token used to list existing cache entries. |
| `cache-key-prefix` | `vcpkg-pkg` | Prefix for all cache keys. Change this to isolate independent cache sets. |
| `vcpkg-root` | _(none)_ | Path to the vcpkg checkout. Scopes the cache to its commit hash. |
| `overlay-ports` | _(none)_ | Path to an overlay ports directory. Scopes the cache to a content hash of all files in it. |
| `installed-dir` | _(auto)_ | Path to `vcpkg_installed` directory. Used to resolve port names for cache keys. Auto-detected if not set. |
| `save-cache` | `true` | Save new packages to cache in the post step. Set to `false` for consumer jobs that only restore. |
| `key` | _(none)_ | Extra key mixed into the cache scope. Use to include compiler version, system packages, or other factors that affect ABI. Supports multiline (one entry per line). |

## Outputs

| Name | Description |
|------|-------------|
| `archives-dir` | Absolute path to the vcpkg binary archives directory. |
| `cache-hit` | Whether all packages from the last successful build are still present in the cache. |

## Cache invalidation

vcpkg computes an [ABI hash](https://learn.microsoft.com/en-us/vcpkg/users/binarycaching#abi-hash)
for every package that encodes its port files, triplet, compiler, features,
and the ABI hashes of all its dependencies (transitively).
The action uses these hashes as cache keys, so correctness is guaranteed by vcpkg itself.

The optional scope inputs control which cache entries are **listed and restored**:

- **`vcpkg-root`** — the cache key includes the vcpkg commit hash.
  Updating your vcpkg checkout means a new scope, so old entries are
  not downloaded and everything rebuilds against the new port definitions.

- **`overlay-ports`** — the cache key includes a content hash of the
  overlay directory. Changing any file in it produces a new scope.
  This is intentionally coarse-grained — it invalidates all entries,
  not just overlay-dependent ones, because the dependency graph is not
  known at restore time. vcpkg's own ABI hashing provides the
  fine-grained per-package invalidation within a scope.

When neither input is set, keys are unscoped (`vcpkg-pkg-<abi-hash>`)
and entries accumulate across vcpkg versions. This still works —
vcpkg ignores stale zips — but wastes cache space over time.

## License

[MIT](LICENSE)
