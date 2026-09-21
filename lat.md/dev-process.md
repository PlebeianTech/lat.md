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

The root workspace contains the TypeScript CLI, the `@lat.md/embed` Rust/WASM engine, the `@lat.md/embed-minilm-fp16` model package, and the `website/` Next.js app.

The CLI, library packages, and Vite UI use the native Go-based TypeScript 7.0.2 compiler, pinned in the root, core, and server development dependencies. It retains the `tsc` command and installs prebuilt platform binaries through pnpm; no Go toolchain is required. Node-targeted TypeScript configurations explicitly include `node` types. The separate Next.js website retains TypeScript 5.9 because Next 15 calls the JavaScript compiler API, which TypeScript 7.0 does not provide.

## Package Manager

pnpm is the only supported package manager. Never use npm or yarn.

## Contribution Workflow

Contributions start from the knowledge graph and keep its design and test specifications synchronized with meaningful implementation changes.

Before changing code, find the relevant intent and expand wiki references in the task:

```bash
pnpm exec lat search "topic or behavior"
pnpm exec lat expand "the task, including any [[refs]]"
```

Use `pnpm exec lat locate "Section Name"` for direct lookup. Update `lat.md/` for meaningful changes to implemented functionality, architecture, behavior, or tests. Plans may be drafted in `lat.md/` alongside implementation, with the intent that by commit time they describe what was implemented. Otherwise, keep proposals, hypothetical designs, and future work outside `lat.md/` unless the user explicitly requests them there. Follow `AGENTS.md` for section and code-reference conventions.

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
- `pnpm build:site` — export this repository's vault as a portable UI server
- `pnpm setup:rust` — prepare the Rust target and project-local build tools
- `pnpm build:wasm` — rebuild the Rust/WASM engine only
- `pnpm build:weights` — rebuild or reuse the MiniLM model package
- `pnpm buildall` — build all workspace packages and the CLI
- `pnpm exec lat check` — validate the knowledge graph and code references

Set `LAT_FORCE_WEIGHTS=1` when running `pnpm build:weights` to download and convert the model again instead of reusing existing artifacts.

The workspace includes [[packages/stemmer]], a compact English Snowball stemmer built from Rust to WASM. The package build shares the pinned wasm-bindgen toolchain with the embedding engine. Its third-party notices include the wrapper's MIT and Snowball algorithms' BSD-3-Clause licenses. Upstream GPL-licensed test data is not compiled into or shipped with the npm package.

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

Every test run includes a full native `tsc --noEmit` pass over the root and UI projects after building core and server declarations. The subprocess has a 90-second limit inside a 120-second test budget for Windows CI.

### Continuous Integration

CI runs `pnpm buildall`, the `vitest` suite, and `lat check` on `ubuntu-latest`. Fork-specific workflow detail — why the check runs a source-built binary, and why Windows left the matrix — is in [[fork#Fork#Continuous integration]].

The separate graph-validation workflow installs and builds the workspace, then runs `lat check` through the checkout's built CLI. This lets unreleased parser and validation behavior verify the repository without third-party actions or the last npm release.

Cross-platform correctness relies on two conventions: stored paths are always POSIX ([[packages/core/src/path.ts#toPosix]]), and a repo-root `.gitattributes` (`eol=lf`) keeps Windows checkouts from rewriting line endings and breaking the markdown roundtrip. Functional init tests run the built CLI and database seeding in child processes so native database handles close before temp cleanup. Lower-level tests that retain handles or spawn a fake `git` use [[tests/util.ts#rmDirBestEffort]].

## Site Development

The repository's site project exports the root vault through `lat ui build server`, exercising the same portable artifact users deploy.

`pnpm build:site` compiles the shared server, downloads the exact published WASM and model artifacts matching this checkout, builds Lat, and writes the server artifact to `.lat-build/server/`.

```bash
pnpm install --frozen-lockfile
pnpm build:site
```

The separate Vercel site project uses `pnpm build:site:vercel` as its only build command. It vendors the current workspace packages, installs the generated artifact, and emits Vercel Build Output API v3 in `.vercel/output`; Vercel's Git integration owns preview deployments without a duplicate GitHub Actions build.

Hosted previews intentionally hydrate the published embedding engine and model matching the checkout's package versions. Changes to those packages require local validation with `pnpm build:site:source` and appear in hosted previews only after publication.

The legacy production project and domain remain outside this deployment path until the generated site is ready to replace them. The legacy `website/` workspace remains in the checkout but is not built by the new project.

## File Walking

All directory walking goes through [[packages/core/src/walk.ts#walkEntries]], the single entry point with nested `.gitignore` support that excludes `.git/`, dotfiles, dot-directories, and symlinks before recursive traversal.

`walkEntries()` retains `ignore-walk`'s nested ignore-rule contexts but owns traversal itself. A bounded queue runs one asynchronous directory job per available CPU; each job uses `readdir` directory entries instead of per-entry `lstat` calls, filters files with file semantics only, and submits visible child directories back to the queue. Results are sorted after reduction, not cached, so long-lived processes such as the MCP server always observe the current filesystem.

Nearest-project discovery and Markdown file listing live in parser-free [[packages/core/src/project-discovery.ts]]. Finding `lat.md/` walks ancestor paths without loading the directory walker; listing Markdown files dynamically loads `walkEntries()` only when enumeration is requested.

Pre-traversal filtering prevents transient files under dot-directories and dependency trees under `node_modules/` from racing or polluting non-Git project scans.

[[packages/core/src/code-refs.ts#walkFiles]] calls `walkEntries()` then additionally skips `.md` files, `lat.md/`, `.claude/`, and sub-projects (directories containing their own `lat.md/`).

[[packages/core/src/code-refs.ts#createCodeReferenceDiscovery]] exposes separate lazy operations for scanning `@lat:` comments and listing the supported source-file scope. The project-scoped object coalesces repeated calls and shares ripgrep exclusion discovery; [[packages/core/src/code-refs.ts#scanCodeRefs]] and [[packages/core/src/code-refs.ts#discoverSourceFiles]] are focused one-shot APIs for callers that need only one result.

Git projects enumerate their tracked regular source files once, excluding symlinks, sources beneath dot-directories, the root vault, and nested Lat projects, then give that identical ordered list to ripgrep or the TypeScript scanner. Untracked build output and ignored files therefore never enter project validation.

Outside Git, both operations first try `rg` (ripgrep), falling back to pure TypeScript discovery and scanning. Ripgrep honors nested `.gitignore` files, uses the fallback's case-insensitive ignore semantics, and excludes dot paths, Markdown, Lat documentation, dependency trees, and nested Lat projects. The [[packages/core/src/source-formats.ts#SOURCE_FILE_EXTENSIONS|supported-source registry]] becomes a custom rg file type rather than positive globs, because positive globs can re-include ignored files. Both scanners use the explicit inventory. Ripgrep emits JSON match records and NUL-delimited filenames, so punctuation cannot forge backlink paths. Source snippet reads resolve symlinks and reject paths outside the project.

The TS fallback uses `walkFiles` for discovery and exclusion filtering, then reads and scans supported files through a bounded async pool with one slot per CPU available to the process. Both paths sort file and reference results by source position, so scheduling cannot reorder references or read diagnostics. `CodeRef.file` is always stored as a projectRoot-relative path; consumers convert to cwd-relative only at display time. Setting `_LAT_DISABLE_RG=1` forces the TS fallback; used in tests to cover both paths.

[[packages/core/src/cli/check.ts#checkIndex]] calls `walkEntries()` on the `lat.md/` directory itself to discover visible entries for index validation.

## Formatting

Prettier with no semicolons, single quotes, trailing commas. Run `pnpm format` before committing.

## Publishing

Release, registry, and distribution are fork-specific. See [[fork-publishing#Publishing]].
