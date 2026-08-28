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

CI runs `pnpm buildall`, the `vitest` suite, and `lat check` on `ubuntu-latest`. Fork-specific workflow detail — why the check runs a source-built binary, and why Windows left the matrix — is in [[fork#Fork#Continuous integration]].

Cross-platform conventions still hold: stored paths are always POSIX ([[src/walk.ts#toPosix]]), and a repo-root `.gitattributes` (`eol=lf`) keeps a Windows checkout from rewriting line endings and breaking the markdown roundtrip.

Functional init tests run the built CLI and database seeding in child processes so native libsql handles close before temp cleanup. Lower-level tests that retain handles or spawn a fake `git` use [[tests/util.ts#rmDirBestEffort]].

## Website Development

The [[website]] is a root pnpm workspace package because its build compiles Lat and exports the repository vault before Next.js runs.

Website builds resolve the embedding engine and model from pinned npm releases through a dedicated TypeScript config. They compile the current CLI and UI without running the workspace Rust, WASM, or model builders.

```bash
pnpm install --frozen-lockfile
pnpm --filter lat-md-website dev
pnpm --filter lat-md-website build
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

Release, registry, and distribution are fork-specific. See [[fork-publishing#Publishing]].
