# Publishing

The fork publishes **`@plebeiantech/lat.md`** to public npm and attaches the same tarball to a GitHub Release. It never publishes under the name `lat.md`, which is upstream's.

Upstream's `publish.yml` was replaced wholesale rather than adapted. That file ran on every push to `main` and ended in `publish_if_new .`, targeting `lat.md` on npm — a package this fork does not own, so a fork version bump would have attempted a publish to someone else's package. The replacement refuses to run at all unless the package name is exactly `@plebeiantech/lat.md`.

The two `@lat.md/*` workspace packages are unchanged from upstream and are already on public npm at the versions this fork pins. `pnpm pack` rewrites their `workspace:*` ranges to those real versions.

## Why the package name is scoped

The scope makes a collision impossible.

A global install of this fork and a global install of upstream's `lat.md` are two different packages that can coexist, and the release workflow refuses to run under any other name — so no accident can put a fork build under upstream's.

## Why both a registry and a Release asset

The registry exists so [mise](https://mise.jdx.dev/) can install the CLI, which it otherwise cannot.

`mise use -g npm:lat.md` resolves against public npm and installs **upstream's** build — the one without any of this fork's checks — while the npm backend rejects a tarball URL as an invalid package name, and the `github`/`ubi` backends expect a runnable binary rather than a package needing its `node_modules`. A scope we own is the only path that leaves mise's version resolution intact.

The Release asset stays because it needs no authentication and no registry at all, which keeps a fallback open if the npm account ever lapses. The publish step runs **after** the release is cut, so a bad token or a registry outage can never prevent the artifact that depends on neither.

## Nothing is built at install time

The published package carries a built `dist/` and `templates/`; there is no `postinstall` step and there must not be one.

The package ships only `dist/src` and `templates`, so there would be nothing to build from. Even shipping sources would put Rust, the exact `wasm-bindgen-cli`, a working C linker and a 90 MB weights fetch on every install, and install scripts are widely disabled anyway — pnpm blocks them by default. The WASM engine and the weights arrive as ordinary npm dependencies instead.

## Fork versioning

The fork's version is a `-fork.N` prerelease of the *next* upstream patch — `0.12.3-fork.1`, not `0.12.2-fork.2`.

A `-fork` prerelease of the current version sorts **below** that version under semver, so `0.12.2-fork.1` reads as older than upstream's `0.12.2` and the CLI reports itself out of date. Anchoring to the next patch keeps the fork sorting above the release it is built from.

The suffix is also load-bearing at runtime: [[fork-publishing#Publishing#Plugin distribution]] uses it to tell a fork build from an upstream one on `PATH`.

## Release notes

Every release carries notes. The workflow uses `.github/release-notes/vX.Y.Z-fork.N.md` when that file exists, and derives the section from the commit range since the previous tag when it does not.

Two failure modes are worth avoiding and the fallback avoids both. A release blocked on notes nobody wrote is a release that does not happen; notes that live only in a file someone must remember to update are notes that go stale silently. A derived default is always accurate and never blocking, and prose replaces it whenever prose is worth writing.

The previous tag comes from `git describe --tags --abbrev=0 "v$VER^"` rather than a sorted tag list, so the answer follows ancestry and does not depend on how `-fork.N` suffixes sort. That needs history, which is why the release job checks out with `fetch-depth: 0` where every other job in this repository does not.

Notes are attached on create **and** on re-run: the workflow calls `gh release edit --notes-file` when the release already exists, so a re-triggered build corrects them rather than leaving the first attempt's text in place.

Releases `fork.1` through `fork.6` were backfilled by hand after the fact.

## Release Workflow

GitHub Actions workflow at `.github/workflows/publish.yml`, triggered by a `v*` tag or manually.

1. **Toolchain setup** — Node 22 + pnpm and a Rust toolchain with the `wasm32-unknown-unknown` target, plus ripgrep so both code-ref scan paths are exercised
2. **Build and tests** — `pnpm install --frozen-lockfile`, `pnpm buildall`, then `pnpm vitest run`
3. **Release guards** — three guards, each failing the run rather than cutting a bad release: the package name must be exactly `@plebeiantech/lat.md`, the version must carry a `-fork.` suffix, and a tag must equal `v$VERSION`
4. **Packing** — `pnpm pack`, which rewrites the `workspace:*` deps to their published versions
5. **Publishing to npm** — `npm publish --provenance --access public --tag fork-N`, then `npm dist-tag add ... latest`. Last so it cannot block the release; skipped when the version is already on npm, or when neither an OIDC credential nor an `NPM_TOKEN` is available
6. **The GitHub Release** — creates the `vX.Y.Z-fork.N` release with both asset names attached, or uploads to an existing one with `--clobber`. Runs before the publish step above

The job holds only `contents: write`; with no `NPM_TOKEN` set, nothing in it contacts a registry at all.

## Authenticating the publish

Publishing uses npm **Trusted Publishing** (OIDC): npm mints a short-lived credential from the workflow's `id-token`, so no long-lived secret has to exist in the repository.

It is configured on npmjs.com against this repository and the `publish.yml` workflow filename, and it requires npm 11.5.1 or newer — the workflow upgrades npm before publishing, because the runner's bundled version is older.

A classic `NPM_TOKEN` secret still works as a fallback, and the step accepts either. One trap is worth knowing: a classic *Publish* token fails in CI with `EOTP`, because publishing under 2FA asks for a one-time password no workflow can supply. Only an *Automation* or granular token bypasses that — which is the problem Trusted Publishing removes entirely.

## Provenance and `repository.url`

The publish is signed with `--provenance`, and npm rejects the upload unless `package.json`'s `repository.url` names the repository the workflow ran in.

A fork inherits upstream's URL, so this fails with a `422` naming both URLs until the field is repointed at the fork. Nothing else validates it, and a local `npm publish` without provenance accepts the stale value happily — the mismatch only surfaces in CI.

## Dist-tags

Every fork version is a semver **prerelease** — the `-fork.N` suffix guarantees it — so npm refuses to publish it without an explicit `--tag` rather than silently moving `latest`.

That tag is `latest`, and it has to be. Trusted Publishing mints a **publish-scoped** credential: the tag chosen at publish time is the only one CI can ever apply, and a follow-up `npm dist-tag add` is answered with a `401`. Publishing under a per-release `fork-N` tag instead would strand `latest` on whichever build shipped first.

The workflow still attempts a `fork-N` tag afterwards, best-effort and never fatal, so it starts working the day a token with dist-tag permission exists. Nothing depends on it: pinning a build works by exact version either way.

```
npm view @plebeiantech/lat.md dist-tags
```

## Why mise needs a settings exclude

`mise use -g npm:@plebeiantech/lat.md@latest` resolves through npm's `latest` dist-tag, and mise applies two filters of its own before it will accept a version.

Only one of them bites. `prereleases` defaults to false and hides every `-fork.N` build from `mise ls-remote`, but an explicit `@latest` resolves through the dist-tag and is unaffected. `minimum_release_age` is the real obstacle: it quarantines anything published within roughly the last day, stable releases included, so a new fork build is invisible until the window passes.

`minimum_release_age_excludes` waives it for one package. That is preferable to setting `prereleases` globally, which would apply to every tool mise manages.

## Plugin distribution

The Claude Code plugin is installed from this repository, which is its own marketplace: `.claude-plugin/marketplace.json` lists one plugin with `"source": "./"`.

```
/plugin marketplace add PlebeianTech/lat.md
/plugin install lat-md@lat-md
```

Installed user-scoped, its hooks fire in every project on the machine, and `/plugin update` pulls new versions.

The plugin ships **hooks only** — no `dist/`. A built CLI needs its runtime `node_modules` beside it, which no plugin repository should carry, so [[src/cli/hook.ts]] is reached through a separately installed binary rather than one bundled with the hooks.

`hooks/lat-guard.sh` resolves that binary from two sources in order: a `dist/` beside the plugin, which means the plugin is running out of a development checkout of this fork; otherwise `lat` on `PATH`, accepted only if `lat --version` contains `-fork`.

That check is the reason the version suffix exists. An upstream CLI answers `hook claude UserPromptSubmit` perfectly happily and without any of the checks these hooks assume, so a session would look grounded while running none of them — worse than the hook not firing at all.
