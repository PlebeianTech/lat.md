# Dev Process

Development workflow, tooling, and conventions for the lat.md project.

## Development Setup

Local development requires Git, Node.js 22, pnpm through Corepack, and Rust with Cargo installed through [rustup](https://rustup.rs/).

Rust compilation also requires the platform's native linker and build tools; rustup will prompt for these where needed.

The required pnpm version comes exclusively from `packageManager` in the root `package.json`. The root `rust-toolchain.toml` selects stable Rust and the `wasm32-unknown-unknown` target.

From the repository root, bootstrap and verify the full project with:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm setup:rust
pnpm buildall
pnpm test
```

`pnpm setup:rust` verifies the WASM target and installs the exact `wasm-bindgen-cli` version from `packages/embed/crate/Cargo.lock` under `packages/embed/.cargo-tools`. WASM builds run this setup automatically, so they never use a global CLI.

The first full build downloads Rust crates and the MiniLM source model, converts the model to fp16, and creates ignored WASM/model artifacts that later builds reuse. Hosted embedding credentials are not required.

Ripgrep is optional but recommended for faster source-reference scans; [[dev-process#File Walking]] provides a tested TypeScript fallback when `rg` is unavailable.

## Tooling

TypeScript ESM project with a Rust-to-WASM embedding engine. Local development mirrors CI so package builds and tests exercise the complete published toolchain.

The root workspace contains the TypeScript CLI, the `@lat.md/embed` Rust/WASM engine, and the `@lat.md/embed-minilm-fp16` model package. The `website/` Next.js app is a separate project with its own lockfile.

## Package Manager

pnpm is the only supported package manager. Never use npm or yarn.

## Contribution Workflow

Contributions start from the knowledge graph and keep its design and test specifications synchronized with meaningful implementation changes.

Before changing code, find the relevant intent and expand wiki references in the task:

```bash
pnpm exec lat search "topic or behavior"
pnpm exec lat expand "the task, including any [[refs]]"
```

Use `pnpm exec lat locate "Section Name"` for direct lookup. Update `lat.md/` for meaningful functionality, architecture, behavior, tests, or planned work; keep it a current snapshot rather than a changelog. Follow `AGENTS.md` for section and code-reference conventions.

Add or update tests with behavior changes. Important tests have a specification under `lat.md/tests/` and exactly one nearby `@lat:` comment in the corresponding test.

Before opening or updating a pull request, run:

```bash
pnpm buildall
pnpm test
pnpm exec lat check
```

Keep pull requests focused and explain user-visible behavior and rationale. Do not commit generated `dist/`, `model/`, `wasm-dist/`, `.cargo-tools/`, or Cargo `target/` artifacts. Version bumps are reserved for maintainer-led releases.

## Development Commands

The root scripts provide focused checks and builds as well as the complete CI-equivalent workflow.

- `pnpm test -- tests/parser.test.ts` — run a focused test file once
- `pnpm test:watch` — run Vitest in watch mode
- `pnpm typecheck` — check TypeScript without emitting files
- `pnpm format` — format `src/**/*.ts`
- `pnpm format:check` — check source formatting
- `pnpm build` — compile the root TypeScript package only
- `pnpm setup:rust` — prepare the Rust target and project-local build tools
- `pnpm build:wasm` — rebuild the Rust/WASM engine only
- `pnpm build:weights` — rebuild or reuse the MiniLM model package
- `pnpm buildall` — build both workspace packages and the CLI
- `pnpm exec lat check` — validate the knowledge graph and code references

Set `LAT_FORCE_WEIGHTS=1` when running `pnpm build:weights` to download and convert the model again instead of reusing existing artifacts.

## Testing

Vitest is the test runner. Tests live in the top-level `tests/` directory.

### Test Structure

Tests use fixture directories under `tests/cases/`, each a self-contained mini-project with its own `lat.md/` and source files.

See [[tests#Conventions]] for testing principles. The test harness in `tests/cases.test.ts` provides helpers (`caseDir()`, `latDir()`) to point `lat` functions at a given fixture.

### Running Tests

Commands for running the test suite.

- `pnpm test` — run all tests once
- `pnpm test:watch` — run in watch mode

### Typecheck Test

Every test run includes a full `tsc --noEmit` pass over the entire codebase. If it doesn't typecheck, it doesn't pass.

### Continuous Integration

CI (`.github/workflows/ci.yml`) runs the full `pnpm buildall` + `vitest` suite on a `[ubuntu-latest, windows-latest]` matrix (`fail-fast: false`) so platform-specific regressions — path separators (see [[parser#Short Ref Resolution]]) and line endings — are caught before release.

Cross-platform correctness relies on two conventions: stored paths are always POSIX ([[src/walk.ts#toPosix]]), and a repo-root `.gitattributes` (`eol=lf`) keeps Windows checkouts from rewriting line endings and breaking the markdown roundtrip. Functional init tests run the built CLI and database seeding in child processes so native libsql handles close before temp cleanup. Lower-level tests that retain handles or spawn a fake `git` use [[tests/util.ts#rmDirBestEffort]].

## Website Development

The [[website]] is outside the root pnpm workspace, so install, run, and build it from its own directory.

```bash
cd website
pnpm install --frozen-lockfile
pnpm dev
pnpm build
```

## File Walking

All directory walking goes through [[src/walk.ts#walkEntries]], the single entry point with `.gitignore` support that filters out `.git/` and dotfiles.

It wraps the `ignore-walk` npm package to ensure `.gitignore` rules are consistently honored everywhere. Results are not cached — each call re-walks the filesystem, which is necessary for long-lived processes like the MCP server.

[[src/code-refs.ts#walkFiles]] calls `walkEntries()` then additionally skips `.md` files, `lat.md/`, `.claude/`, and sub-projects (directories containing their own `lat.md/`).

[[src/code-refs.ts#scanCodeRefs]] uses a two-tier strategy for finding `@lat:` comments: it first tries `rg` (ripgrep), falling back to a pure TypeScript implementation. When rg is available, it handles both searching and file listing — `walkFiles` is not called. Exclusions for `lat.md/`, `.claude/`, `*.md`, and sub-projects are passed as `--glob` args to rg. Sub-projects are detected upfront via `rg --files` (directories containing a nested `lat.md/`). The TS fallback uses `walkFiles` for both file discovery and exclusion filtering. `CodeRef.file` is always stored as a projectRoot-relative path; consumers convert to cwd-relative only at display time. Setting `_LAT_DISABLE_RG=1` forces the TS fallback; used in tests to cover both paths.

[[src/cli/check.ts#checkIndex]] calls `walkEntries()` on the `lat.md/` directory itself to discover visible entries for index validation.

## Formatting

Prettier with no semicolons, single quotes, trailing commas. Run `pnpm format` before committing.

## Publishing

The fork publishes **`@plebeiantech/lat.md`** to public npm and attaches the same tarball to a GitHub Release. It never publishes under the name `lat.md`, which is upstream's.

Upstream's `publish.yml` was replaced wholesale rather than adapted. That file ran on every push to `main` and ended in `publish_if_new .`, targeting `lat.md` on npm — a package this fork does not own, so a fork version bump would have attempted a publish to someone else's package. The replacement refuses to run at all unless the package name is exactly `@plebeiantech/lat.md`.

The two `@lat.md/*` workspace packages are unchanged from upstream and are already on public npm at the versions this fork pins. `pnpm pack` rewrites their `workspace:*` ranges to those real versions.

### Why the package name is scoped

The scope makes a collision impossible.

A global install of this fork and a global install of upstream's `lat.md` are two different packages that can coexist, and the release workflow refuses to run under any other name — so no accident can put a fork build under upstream's.

### Why both a registry and a Release asset

The registry exists so [mise](https://mise.jdx.dev/) can install the CLI, which it otherwise cannot.

`mise use -g npm:lat.md` resolves against public npm and installs **upstream's** build — the one without any of this fork's checks — while the npm backend rejects a tarball URL as an invalid package name, and the `github`/`ubi` backends expect a runnable binary rather than a package needing its `node_modules`. A scope we own is the only path that leaves mise's version resolution intact.

The Release asset stays because it needs no authentication and no registry at all, which keeps a fallback open if the npm account ever lapses. The publish step runs **after** the release is cut, so a bad token or a registry outage can never prevent the artifact that depends on neither.

### Two install routes

Both serve the same build.

```
mise use -g npm:@plebeiantech/lat.md@latest
```

```
npm i -g --prefix ~/.local/lat https://github.com/PlebeianTech/lat.md/releases/latest/download/lat.md-latest.tgz
```

The second wants `~/.local/lat/bin` on `PATH`. A fixed prefix rather than the default global one keeps that install independent of the active Node version, which a version manager would otherwise change underneath it.

### Nothing is built at install time

The published package carries a built `dist/` and `templates/`; there is no `postinstall` step and there must not be one.

The package ships only `dist/src` and `templates`, so there would be nothing to build from. Even shipping sources would put Rust, the exact `wasm-bindgen-cli`, a working C linker and a 90 MB weights fetch on every install, and install scripts are widely disabled anyway — pnpm blocks them by default. The WASM engine and the weights arrive as ordinary npm dependencies instead.

### Fork versioning

The fork's version is a `-fork.N` prerelease of the *next* upstream patch — `0.12.3-fork.1`, not `0.12.2-fork.2`.

A `-fork` prerelease of the current version sorts **below** that version under semver, so `0.12.2-fork.1` reads as older than upstream's `0.12.2` and the CLI reports itself out of date. Anchoring to the next patch keeps the fork sorting above the release it is built from.

The suffix is also load-bearing at runtime: [[dev-process#Publishing#Plugin distribution]] uses it to tell a fork build from an upstream one on `PATH`.

### Release Process

Cutting a release is a deliberate act, triggered by a tag rather than by a merge.

1. **Bump the version** — `version` in the root `package.json`, keeping the `-fork.N` suffix. Commit message: `Bump to X.Y.Z-fork.N`
2. **Verify green** — `pnpm buildall && pnpm test`, and `lat check` on this repository's own `lat.md/`
3. **Tag** — `git tag vX.Y.Z-fork.N` and push the tag. The tag must match `package.json` exactly; [[dev-process#Publishing#Release Workflow]] refuses the release otherwise
4. **Install anywhere** — `npm i -g` against the release asset URL

Each release carries the tarball twice: under its versioned name, and again as `lat.md-latest.tgz`. GitHub's `/releases/latest/` redirect resolves the release but not an asset name, so a version-free URL needs a version-free asset to point at:

```
npm i -g https://github.com/PlebeianTech/lat.md/releases/latest/download/lat.md-latest.tgz
```

The versioned URL stays available for pinning. `latest` follows whichever release GitHub considers current, which excludes any release marked as a prerelease — the `-fork.N` suffix in the version does not itself mark one.

The two `@lat.md/*` packages are never bumped or published here. They are upstream's, unmodified, and already released.

### Release Workflow

GitHub Actions workflow at `.github/workflows/publish.yml`, triggered by a `v*` tag or manually.

1. **Set up the toolchain** — Node 22 + pnpm and a Rust toolchain with the `wasm32-unknown-unknown` target, plus ripgrep so both code-ref scan paths are exercised
2. **Build and test** — `pnpm install --frozen-lockfile`, `pnpm buildall`, then `pnpm vitest run`
3. **Refuse a wrong release** — three guards, each failing the run rather than cutting a bad release: the package name must be exactly `@plebeiantech/lat.md`, the version must carry a `-fork.` suffix, and a tag must equal `v$VERSION`
4. **Pack** — `pnpm pack`, which rewrites the `workspace:*` deps to their published versions
5. **Publish** — `npm publish --provenance --access public --tag fork-N`, then `npm dist-tag add ... latest`. Last so it cannot block the release; skipped when the version is already on npm, or when neither an OIDC credential nor an `NPM_TOKEN` is available
6. **Release** — creates the `vX.Y.Z-fork.N` release with both asset names attached, or uploads to an existing one with `--clobber`. Runs before the publish step above

The job holds only `contents: write`; with no `NPM_TOKEN` set, nothing in it contacts a registry at all.

### Authenticating the publish

Publishing uses npm **Trusted Publishing** (OIDC): npm mints a short-lived credential from the workflow's `id-token`, so no long-lived secret has to exist in the repository.

It is configured on npmjs.com against this repository and the `publish.yml` workflow filename, and it requires npm 11.5.1 or newer — the workflow upgrades npm before publishing, because the runner's bundled version is older.

A classic `NPM_TOKEN` secret still works as a fallback, and the step accepts either. One trap is worth knowing: a classic *Publish* token fails in CI with `EOTP`, because publishing under 2FA asks for a one-time password no workflow can supply. Only an *Automation* or granular token bypasses that — which is the problem Trusted Publishing removes entirely.

### Provenance and `repository.url`

The publish is signed with `--provenance`, and npm rejects the upload unless `package.json`'s `repository.url` names the repository the workflow ran in.

A fork inherits upstream's URL, so this fails with a `422` naming both URLs until the field is repointed at the fork. Nothing else validates it, and a local `npm publish` without provenance accepts the stale value happily — the mismatch only surfaces in CI.

### Dist-tags

Every fork version is a semver **prerelease** — the `-fork.N` suffix guarantees it — so npm refuses to publish it without an explicit `--tag` rather than silently moving `latest`.

Each release is published under its own tag, `fork-N`, derived from the version: `0.12.3-fork.2` becomes `fork-2`. Any build therefore stays installable by name after later ones ship.

`latest` is then moved onto the same version as a second step. npm will not do that implicitly for a prerelease, and skipping it would leave `latest` pinned to whichever build was published first — silently installing a stale version for anyone following the documented `mise use -g npm:@plebeiantech/lat.md@latest`.

```
npm view @plebeiantech/lat.md dist-tags
```

### Plugin distribution

The Claude Code plugin is installed from this repository, which is its own marketplace: `.claude-plugin/marketplace.json` lists one plugin with `"source": "./"`.

```
/plugin marketplace add PlebeianTech/lat.md
/plugin install lat-md@lat-md
```

Installed user-scoped, its hooks fire in every project on the machine, and `/plugin update` pulls new versions.

The plugin ships **hooks only** — no `dist/`. A built CLI needs its runtime `node_modules` beside it, which no plugin repository should carry, so [[src/cli/hook.ts]] is reached through a separately installed binary rather than one bundled with the hooks.

`hooks/lat-guard.sh` resolves that binary from two sources in order: a `dist/` beside the plugin, which means the plugin is running out of a development checkout of this fork; otherwise `lat` on `PATH`, accepted only if `lat --version` contains `-fork`.

That check is the reason the version suffix exists. An upstream CLI answers `hook claude UserPromptSubmit` perfectly happily and without any of the checks these hooks assume, so a session would look grounded while running none of them — worse than the hook not firing at all.
