# Fork

How this fork of [vercel-labs/lat.md](https://github.com/vercel-labs/lat.md) diverges from upstream, and the rules that keep those divergences cheap to carry.

The fork publishes as `@plebeiantech/lat.md` and never under upstream's `lat.md` name. Its remote is `PlebeianTech/lat.md`; `upstream` is a fetch-only remote whose push URL is disabled.

## Keeping the diff small

Every upstream file this fork edits is a merge conflict waiting to happen. A file we only add is not, so new behaviour belongs in new fork-owned files.

The target shape for anything that must reach upstream code: a new module holding the logic, plus an import and one call line in the upstream file. `src/cli/check-status.ts` and `src/cli/check-frontmatter.ts` are the reference implementations — each is a new file whose entire upstream footprint is an import and one appended line in `checkAllCommand`.

Five rules follow from that, in the order they are worth applying.

### Never delete an upstream file

A deleted file that upstream later modifies produces a delete/modify conflict on **every** future merge. A modified file conflicts once and stays resolved.

Leave an unwanted upstream file in place and change what it does, or turn it off out of band.

### Keep tests in fork-owned files

A test for fork-owned code has no reason to live in an upstream test file, and appending to one converts a zero-cost addition into a permanent conflict site.

### Change things at the fork-owned end of a call

When our code calls upstream's, adjust the result in our file rather than editing theirs. Only reach into an upstream function when no fork-owned call site exists.

### Docs are ours, so write our own

Fork-specific documentation belongs in fork-owned files like this one, linked from upstream docs rather than written into them. That keeps an upstream doc's diff to a link.

### Name a new file something upstream would not reach for

Two files added independently never conflict in git and can still collide in the graph, because a short-form `[[name]]` reference resolves by bare filename.

`lat.md/tests/graph.md` and upstream's later `lat.md/view/graph.md` are the worked example — see [[fork#Merging upstream#What a clean merge still breaks]]. Prefer a name that says what the fork-owned thing is, not the general topic it sits under.

## The instruction channel

What `lat init` teaches a consumer project's agent reaches it through a fork-owned template and a fork-owned marker block, so the fork can say more without editing upstream's onboarding text.

Upstream's channel is two files: `templates/AGENTS.md`, written into `CLAUDE.md` / `AGENTS.md` / `.github/copilot-instructions.md` inside `%% lat:begin %%` markers, and `templates/skill/SKILL.md`, written whole into each agent's skills directory. Both are upstream's own agent-facing prose and among the files upstream most often revises, so every sentence the fork adds is a conflict bought on credit.

`templates/fork/conventions.md` replaces that. [[src/cli/fork-instructions.ts#writeForkInstructions]] appends it under its own `%% lat-fork:begin %%` / `%% lat-fork:end %%` markers and writes it again, with frontmatter, as a separate `lat-md-conventions` skill. The whole upstream footprint is one import and one call in `initCmd`.

Moving the fork's existing Diátaxis prose into it took `templates/AGENTS.md` off [[fork#The upstream guard#The allowlist]] entirely and returned `templates/skill/SKILL.md` to upstream's exact bytes — the diff got *smaller* while the instruction got stronger. Test spec: [[tests/fork-instructions]].

### Why two markers rather than one section

Upstream's `appendTemplateSection` rewrites the span between its own markers in place, splicing around whatever sits outside them.

A fork block after `%% lat:end %%` is therefore untouched by every upstream re-run, and upstream's block is untouched by every fork re-run. Merging the two into one section would give both writers the same span and make the last one to run the winner.

### Why the skill is a separate file

Upstream writes its `lat-md` skill with `writeTemplateFile`, which compares a hash of the **whole** file against the one recorded at write time.

Appending to that file changes the whole-file hash, so every later `lat init` would report the skill as user-modified and stop to ask. A second skill directory has no such coupling. It also earns its keep: `lat-md` is upstream's authoring syntax, `lat-md-conventions` is what `lat check` fails on here.

### What the template demands

Three rules, each written because an agent was observed to miss it.

Every document goes in a Diátaxis mode directory, and a document that would fail its mode is two documents rather than one softened one. Every project carries at least one `@lat:` ref, starting at the application entrypoint and pointing at the root index. An `@lat:` pointer is a machine directive and is exempt from any project convention that minimises comments — and the marker is a comment syntax, not a language allowlist, so no example list should be read as an exclusion.

## The Diátaxis gate

`lat init` scaffolds the four mode directories into a fresh `lat.md/` and stamps [[markdown#Frontmatter#require-mode]] into the root index, so a project set up after this existed cannot quietly place its documents where no shape rule reaches them.

[[cli#check#mode]] binds only inside `tutorials/`, `how-to/`, `reference/` and `explanation/`. A tree whose documents all sit flat at the top therefore passes every mode rule by never being subject to one — and an agent asked to document a codebase writes flat files, because upstream's `templates/init/` is one root index and nothing suggests otherwise. A bella-derms session did exactly that, and confirmed on request that its largest document produced 64 errors the moment it was copied into `reference/`.

Two halves, and the order matters. [[src/cli/fork-scaffold.ts#writeForkScaffold]] makes the directories exist, each with an index written to satisfy its own mode, so correct placement is the path of least resistance. The `require-mode` flag then makes flat placement an error rather than an option. Structure without the gate is a suggestion; the gate without structure is an error message with nowhere to point. Test spec: [[tests/fork-scaffold]].

### Why the flag lives in the tree

An opt-in flag in the root index, rather than a CLI flag or an environment variable, is what lets the rule ship without breaking anything.

This repository's own `lat.md/` is eleven flat documents. Gating every tree would fail it on the commit that introduced the gate, and the honest repair — assigning modes and then splitting the documents that fail them — is real restructuring work that has nothing to do with shipping the rule. A flag read from the tree makes adoption a decision each project makes once.

### Adopting it in a tree that already exists

`writeForkScaffold` runs only on the branch that creates `lat.md/`, so `lat init` offers the flag separately to every tree it did not create.

The first version had no such offer, which left the gate unreachable for exactly the projects that needed it: a re-run on an existing project picked up the instruction block and the conventions skill and silently skipped the flag. Restructuring someone's tree unasked is still wrong, so the offer prints how many documents would need a mode, then asks. A refusal is recorded in a fork-owned `lat.md/.cache/lat_fork.json` and never asked again; a run with no TTY prints the frontmatter to paste and records nothing, because the shared `ask` returns true whenever readline is absent and a silent yes is the one answer this must not give.

### What the scaffold writes

Four directories, four indexes, and two additions to the root index.

Each mode index is written to the rule it will be checked against rather than to one house style: the tutorial index carries ordered steps and a stated outcome, the how-to index carries ordered steps, the reference index carries no second paragraph. The root index gains the `require-mode` frontmatter and a listing of the four directories — the listing because without it `lat check index` reports four missing entries on a tree `lat init` has just created, which is a poor first impression of a tool whose pitch is that the check passes.

## The code-ref floor

A `lat.md/` tree that holds documents and has no `@lat:` ref pointing into it from anywhere in the codebase fails `lat check`, whatever its frontmatter says.

[[markdown#Frontmatter#require-code-mention]] was the only thing asking for refs, and it is opt-in: an agent setting up a tree can decline to write it and every check still passes. One did, and gave two reasons worth recording because neither was carelessness. It read "Supported comment styles: `//` (JS/TS/Rust/Go/C) and `#` (Python)" as an exclusive list and concluded Ruby was unsupported — the list enumerates comment syntaxes, and [[src/code-refs.ts#scanCodeRefs]] is textual and reads every non-markdown file. And it was optimising for a green check rather than a correct one, so of two paths it took the one that could not fail.

The floor is one ref, not a ratio. A per-document rule would fail this repository, where `dev-process`, `markdown`, `parser`, `website` and everything under `view/` have no incoming ref and are not worse for it — the rule would have to be either wrong here or watered down everywhere. Test spec: [[tests/check-coverage]].

### Why the entrypoint is named in the message rather than checked

Naming the application entrypoint means guessing per framework, and a check that guesses wrong is a check that gets turned off.

`config/application.rb`, `manage.py`, `main.go`, `src/index.ts`, a Cargo bin target — the right answer differs per project and sometimes per directory. So the gate counts refs and the failure message names the convention, quoting the root index's own H1 so the suggested line can be pasted as-is. A generic placeholder would be pasted verbatim and then fail [[cli#check#code-refs]], turning one error into two.

`~/plebtech/sway` arrived at the same convention by hand before any of this existed: `config/application.rb` and `app/frontend/entrypoints/application.tsx` each carry a ref to the root index, one per entrypoint.

### Why the message argues rather than instructs

Two of the three paragraphs in the failure exist to answer an objection the reader already holds.

An agent working in a repository whose convention is that comments are untrusted input — subtractive, budgeted, justified — is right about prose comments and will apply that rule here unless told the boundary. So the message says what an `@lat:` line is: a machine directive in the same class as `# frozen_string_literal:` or `// eslint-disable`, carrying no rationale and unable to rot quietly, because `lat check` fails the moment its target moves. The other paragraph corrects the language-allowlist reading directly, at the moment it matters.

## Turning a workflow off without editing it

Whether a GitHub Actions workflow runs is repository **state**, not file content, so a workflow can be disabled without appearing in the diff at all.

```
gh workflow disable "<name>" --repo PlebeianTech/lat.md
gh workflow enable  "<name>" --repo PlebeianTech/lat.md
gh workflow list --all --repo PlebeianTech/lat.md
```

The cost is that the state is invisible in a checkout: someone cloning the repository cannot tell from the files why a workflow never runs. Record any use of it here, and prefer editing the workflow when the edit is small — CI files are explicitly fine to edit in this fork.

Nothing is disabled at present. Both workflows run: `ci.yml` builds, tests, and runs `lat check` from source, and `lat-check.yaml` installs the published package and checks the tree with it.

## Continuous integration

Two workflows validate the tree, and both run our own build of `lat` rather than upstream's.

`ci.yml` runs `pnpm buildall`, the `vitest` suite, and then `lat check` using the binary that commit just built. Checking with the source build rather than a published one is the stricter choice: a change to the check rules is validated by its own checker in the same run.

`lat-check.yaml` installs the published `@plebeiantech/lat.md` and runs `lat check` with it. That is deliberately redundant with the source-built check — it smoke-tests the published tarball against a real repository, which a source build cannot do.

Upstream's version of `lat-check.yaml` used `lars20070/lat-check-action@v1`, whose `action.yaml` hardcodes `npm install -g lat.md` with no input to override it. Upstream's `parseIndexEntries` matches only `- [[name]] — description`. This fork's writes `- [Label](dest.md) — description` and its parser reads both, so upstream's sees zero entries in our index files and reports every child as missing. It never once passed. Pinning it to a commit would have fixed the mutable-tag exposure without fixing the failure.

Windows is not in the `ci.yml` matrix. The POSIX-path and `eol=lf` conventions in [[dev-process#Testing#Continuous Integration]] still hold, but no runner enforces them.

## Verifying a file's ownership

Before editing anything, resolve whether upstream owns it. The question is asked at the sync point, not at the original fork point, so a file upstream added later still answers `UPSTREAM`.

```
SYNC=$(awk 'NF && $1 !~ /^#/ {print $1; exit}' fork-upstream-sync-point)
git cat-file -e "$SYNC:<path>" && echo UPSTREAM || echo fork-owned
```

The `NF` guard matters: the recorded revision sits below a blank line, so a
plain `grep -v '^#' | head -1` selects the blank and silently answers the
wrong question. `parseSyncPoint` skips blanks for the same reason.

## The upstream guard

A checker that compares the working tree against the sync point and fails when the diff touches an upstream file that `fork-upstream-allowlist.tsv` does not name. It is what turns [[fork#Keeping the diff small]] from prose into a build step.

The rule was broken twice in one session by agents who did not disagree with it — they were moving fast, and prose does not stop that. Mechanism does.

```
node dist/src/fork/upstream-guard-cli.js
pnpm exec tsx src/fork/upstream-guard-cli.ts
```

Both lines run the same program. The first needs `pnpm build` to have run; the second needs only `pnpm install`. `--repo`, `--sync-point`, `--allowlist`, and `--sync-point-file` override the defaults, which are the working directory, the recorded sync point, and the two files at the repository root.

A path is upstream when it resolves to a blob in the sync point's tree, so every file the fork added is invisible to the check and costs nothing. The diff is taken with `--no-renames`, which makes a renamed upstream file read as a deletion plus an addition — and a deletion is refused.

### The sync point

`fork-upstream-sync-point` records the last upstream commit merged into this fork, and every measurement the guard makes is taken relative to it.

A frozen baseline cannot work. The guard was first written against the fork point `65d2f5b`, which made it read upstream's own commits as fork divergence the moment upstream was merged — 27 violations, every one of them a file the fork had never touched. Advancing the record in the same commit as the merge is what keeps the number honest.

The same baseline decides ownership. A file upstream added after the fork point is upstream's, and a check anchored at the fork point would call it fork-owned and wave an unexplained edit through.

```
node dist/src/fork/upstream-guard-cli.js --set-sync-point <rev>
```

The revision has to be an ancestor of `HEAD` already: a sync point off the current history makes the diff meaningless, so recording one before its merge lands is refused. A shallow clone cannot answer the ancestry question at all, and skips the check rather than failing on truncated history.

### The allowlist

`fork-upstream-allowlist.tsv` holds one entry per line: the repository-relative path, a tab, then the reason the fork must diverge in that file. Blank lines and `#` comments are ignored.

```
src/cli/check.ts	Registration point for check subcommands. Each fork-owned check module reaches it as one import plus one appended line; the logic itself is in the fork-owned file.
```

The reason is the point of the file. A path with no reason, or one still carrying the `TODO` marker the generator writes, fails the check exactly as an unlisted path does — an allowlist nobody explained is a list of unexplained conflicts.

To add an entry, regenerate rather than hand-editing:

```
node dist/src/fork/upstream-guard-cli.js --regenerate
```

Regenerating rewrites the list from the current diff, keeps the reason already recorded against a path, drops paths nothing modifies any more, and marks anything new as needing a reason. Then replace each marker with why that file must diverge. A stale entry — allowlisted but no longer modified — is reported as a warning rather than a failure, so regenerating is a tidy-up, never a gate.

### Deletions are not allowlistable

Any deletion of an upstream file fails the check, allowlisted or not. There is no flag, no entry, and no override.

The asymmetry is the whole reason: a file this fork deletes produces a delete/modify conflict on **every** future merge that touches it upstream, while a file this fork modifies conflicts once and stays resolved. See [[fork#Keeping the diff small#Never delete an upstream file]] for what to do instead.

The regenerate path honours the same rule. It refuses to write a deletion into the list and reports it, so a deletion cannot be laundered into an exception by running the generator.

### Running it in CI

`ci.yml` runs the guard in one step, immediately after `pnpm install --frozen-lockfile` and before the build.

```
- name: Upstream guard
  run: pnpm exec tsx src/fork/upstream-guard-cli.ts --fetch
```

`actions/checkout@v4` clones with `fetch-depth: 1`, so the sync-point commit is **not** in the runner's object store and every git command against it fails. `--fetch` runs `git fetch --no-tags --depth=1 origin <sync point>` when the commit is absent, which GitHub serves for an arbitrary reachable SHA. Keeping the revision in `fork-upstream-sync-point` rather than in the workflow leaves one place for it to be wrong.

Nothing under `.github/` carries a `@lat:` pointer. `walk.ts` filters every path beginning with `.`, so no workflow file is ever scanned and a ref placed there would rot without `lat check` noticing. Workflows reference this document in prose instead.

Without `--fetch` the guard does not silently pass: it exits non-zero and prints the fetch command. That is the deliberate half of the design — the two failure modes worth avoiding are a check that always passes and a check that always fails, and a missing sync point produces neither silence nor a false accusation.

The step runs before the build so the sync point is already fetched by the time `vitest` runs, which is what lets the suite assert that this repository itself passes the guard.

## Merging upstream

Merging is cheap when the fork's own rules have been kept. Most of the procedure is moving the sync point and re-deriving the allowlist from it.

1. **Look before merging** — `git fetch upstream`, then `git merge-tree --write-tree --name-only HEAD upstream/main` names every conflict without touching the working tree
2. **Merge** — `git merge upstream/main`, resolving what git reports
3. **Install** — `pnpm install`, since upstream may have added dependencies
4. **Move the sync point** — `--set-sync-point <the upstream commit just merged>`
5. **Regenerate the allowlist** — the baseline moved, so the set of files the fork diverges in moved with it; replace any `TODO` marker the generator writes
6. **Check the whole tree** — `pnpm typecheck`, `pnpm build`, `pnpm vitest run --dir tests`, and `lat check`

Steps 4 and 5 belong in the merge commit or the one right after it. Between the merge and the new sync point, the guard is measuring against a baseline that no longer describes anything.

### What a clean merge still breaks

A merge git calls clean is not the same as a merged tree that works, and the 0.12.2 merge produced one instance of each failure this fork has seen.

A **type widened underneath us**. Upstream added a field to what `searchSections` returns, and a fork-owned test's fixture no longer satisfied it. `pnpm typecheck` catches this; the merge itself cannot.

A **name collided**. Upstream added `lat.md/view/graph.md` while the fork already had `lat.md/tests/graph.md`. Two additions, no textual overlap, and every short-form `[[graph#...]]` reference became ambiguous — 32 `lat check` errors, two of them inside upstream's own documents, which this fork's filename had broken. Renaming the fork-owned file fixed all 32 and left upstream's links alone. See [[fork#Keeping the diff small#Name a new file something upstream would not reach for]].

Neither is visible to the upstream guard, which reads paths rather than contents. The suite and `lat check` are what close that gap, which is why step 6 runs the whole tree rather than the files the merge touched.

## Watching the drift

A weekly workflow fetches upstream, trial-merges it, and reports what it finds, so the cost of the next merge is a standing number rather than a surprise.

```
pnpm exec tsx src/fork/upstream-drift-cli.ts
```

It reports how far upstream has moved past the sync point, which files it touched, which files **both** sides changed, and whether `git merge-tree` finds a textual conflict. The both-sides list is the leading indicator: those are the files the next conflict will come from, even in a week when the merge is clean.

The workflow then merges for real in the runner's checkout and runs `pnpm typecheck` and `lat check` on the result, because [[fork#Merging upstream#What a clean merge still breaks]] is not visible to `git merge-tree`. It never pushes and never writes to any remote — the upstream fetch is read-only, and nothing is posted to a repository this project does not own.

`--fail-on-conflict` turns the report into a gate. It is off by default: a conflict with upstream is information, not a broken build.

## Publishing

The fork publishes **`@plebeiantech/lat.md`** to public npm and attaches the same tarball to a GitHub Release. It never publishes under the name `lat.md`, which is upstream's.

Upstream's `publish.yml` was replaced wholesale rather than adapted. That file ran on every push to `main` and ended in `publish_if_new .`, targeting `lat.md` on npm — a package this fork does not own, so a fork version bump would have attempted a publish to someone else's package. The replacement refuses to run at all unless the package name is exactly `@plebeiantech/lat.md`.

The two `@lat.md/*` workspace packages are unchanged from upstream and are already on public npm at the versions this fork pins. `pnpm pack` rewrites their `workspace:*` ranges to those real versions.

#### Why the package name is scoped

The scope makes a collision impossible.

A global install of this fork and a global install of upstream's `lat.md` are two different packages that can coexist, and the release workflow refuses to run under any other name — so no accident can put a fork build under upstream's.

#### Why both a registry and a Release asset

The registry exists so [mise](https://mise.jdx.dev/) can install the CLI, which it otherwise cannot.

`mise use -g npm:lat.md` resolves against public npm and installs **upstream's** build — the one without any of this fork's checks — while the npm backend rejects a tarball URL as an invalid package name, and the `github`/`ubi` backends expect a runnable binary rather than a package needing its `node_modules`. A scope we own is the only path that leaves mise's version resolution intact.

The Release asset stays because it needs no authentication and no registry at all, which keeps a fallback open if the npm account ever lapses. The publish step runs **after** the release is cut, so a bad token or a registry outage can never prevent the artifact that depends on neither.

#### Two install routes

Both serve the same build.

```
mise settings add minimum_release_age_excludes npm:@plebeiantech/lat.md
mise use -g npm:@plebeiantech/lat.md@latest
```

The `settings add` line is not optional. mise's `minimum_release_age` quarantines packages published within the last few days, and a fork release is always inside that window — so without the waiver mise filters out every candidate version and fails with `no versions found for npm:@plebeiantech/lat.md matching date filter`, which reads as if the package does not exist. Pinning an older version does not help; they are all too new. The waiver is permanent by necessity, and waiving an age check on a package you publish yourself is what the setting is for.

```
npm i -g --prefix ~/.local/lat https://github.com/PlebeianTech/lat.md/releases/latest/download/lat.md-latest.tgz
```

The second wants `~/.local/lat/bin` on `PATH`. A fixed prefix rather than the default global one keeps that install independent of the active Node version, which a version manager would otherwise change underneath it.

The two routes must not both be live on one machine. `~/.local/lat/bin` is prepended to `PATH`, so a Release-route install shadows a mise-managed one, and `mise upgrade` then reports a version the shell never runs.

#### Nothing is built at install time

The published package carries a built `dist/` and `templates/`; there is no `postinstall` step and there must not be one.

The package ships only `dist/src` and `templates`, so there would be nothing to build from. Even shipping sources would put Rust, the exact `wasm-bindgen-cli`, a working C linker and a 90 MB weights fetch on every install, and install scripts are widely disabled anyway — pnpm blocks them by default. The WASM engine and the weights arrive as ordinary npm dependencies instead.

#### Fork versioning

The fork's version is a `-fork.N` prerelease of the *next* upstream patch — `0.12.3-fork.1`, not `0.12.2-fork.2`.

A `-fork` prerelease of the current version sorts **below** that version under semver, so `0.12.2-fork.1` reads as older than upstream's `0.12.2` and the CLI reports itself out of date. Anchoring to the next patch keeps the fork sorting above the release it is built from.

The suffix is also load-bearing at runtime: [[fork#Publishing#Plugin distribution]] uses it to tell a fork build from an upstream one on `PATH`.

#### Release Process

Cutting a release is a deliberate act, triggered by a tag rather than by a merge.

1. **Write the notes** — `.github/release-notes/vX.Y.Z-fork.N.md`, saying what changed and why. Optional but expected; see [[fork#Publishing#Release notes]]
2. **Bump the version** — `version` in the root `package.json`, keeping the `-fork.N` suffix. Commit message: `Bump to X.Y.Z-fork.N`
3. **Verify green** — `pnpm buildall && pnpm test`, and `lat check` on this repository's own `lat.md/`
4. **Tag** — `git tag vX.Y.Z-fork.N` and push the tag. The tag must match `package.json` exactly; [[fork#Publishing#Release Workflow]] refuses the release otherwise
5. **Install anywhere** — `npm i -g` against the release asset URL

Each release carries the tarball twice: under its versioned name, and again as `lat.md-latest.tgz`. GitHub's `/releases/latest/` redirect resolves the release but not an asset name, so a version-free URL needs a version-free asset to point at:

```
npm i -g https://github.com/PlebeianTech/lat.md/releases/latest/download/lat.md-latest.tgz
```

The versioned URL stays available for pinning. `latest` follows whichever release GitHub considers current, which excludes any release marked as a prerelease — the `-fork.N` suffix in the version does not itself mark one.

The two `@lat.md/*` packages are never bumped or published here. They are upstream's, unmodified, and already released.

#### Release notes

Every release carries notes. The workflow uses `.github/release-notes/vX.Y.Z-fork.N.md` when that file exists, and derives the section from the commit range since the previous tag when it does not.

Two failure modes are worth avoiding and the fallback avoids both. A release blocked on notes nobody wrote is a release that does not happen; notes that live only in a file someone must remember to update are notes that go stale silently. A derived default is always accurate and never blocking, and prose replaces it whenever prose is worth writing.

The previous tag comes from `git describe --tags --abbrev=0 "v$VER^"` rather than a sorted tag list, so the answer follows ancestry and does not depend on how `-fork.N` suffixes sort. That needs history, which is why the release job checks out with `fetch-depth: 0` where every other job in this repository does not.

Notes are attached on create **and** on re-run: the workflow calls `gh release edit --notes-file` when the release already exists, so a re-triggered build corrects them rather than leaving the first attempt's text in place.

Releases `fork.1` through `fork.6` were backfilled by hand after the fact.

#### Release Workflow

GitHub Actions workflow at `.github/workflows/publish.yml`, triggered by a `v*` tag or manually.

1. **Set up the toolchain** — Node 22 + pnpm and a Rust toolchain with the `wasm32-unknown-unknown` target, plus ripgrep so both code-ref scan paths are exercised
2. **Build and test** — `pnpm install --frozen-lockfile`, `pnpm buildall`, then `pnpm vitest run`
3. **Refuse a wrong release** — three guards, each failing the run rather than cutting a bad release: the package name must be exactly `@plebeiantech/lat.md`, the version must carry a `-fork.` suffix, and a tag must equal `v$VERSION`
4. **Pack** — `pnpm pack`, which rewrites the `workspace:*` deps to their published versions
5. **Publish** — `npm publish --provenance --access public --tag fork-N`, then `npm dist-tag add ... latest`. Last so it cannot block the release; skipped when the version is already on npm, or when neither an OIDC credential nor an `NPM_TOKEN` is available
6. **Release** — creates the `vX.Y.Z-fork.N` release with both asset names attached, or uploads to an existing one with `--clobber`. Runs before the publish step above

The job holds only `contents: write`; with no `NPM_TOKEN` set, nothing in it contacts a registry at all.

#### Authenticating the publish

Publishing uses npm **Trusted Publishing** (OIDC): npm mints a short-lived credential from the workflow's `id-token`, so no long-lived secret has to exist in the repository.

It is configured on npmjs.com against this repository and the `publish.yml` workflow filename, and it requires npm 11.5.1 or newer — the workflow upgrades npm before publishing, because the runner's bundled version is older.

A classic `NPM_TOKEN` secret still works as a fallback, and the step accepts either. One trap is worth knowing: a classic *Publish* token fails in CI with `EOTP`, because publishing under 2FA asks for a one-time password no workflow can supply. Only an *Automation* or granular token bypasses that — which is the problem Trusted Publishing removes entirely.

#### Provenance and `repository.url`

The publish is signed with `--provenance`, and npm rejects the upload unless `package.json`'s `repository.url` names the repository the workflow ran in.

A fork inherits upstream's URL, so this fails with a `422` naming both URLs until the field is repointed at the fork. Nothing else validates it, and a local `npm publish` without provenance accepts the stale value happily — the mismatch only surfaces in CI.

#### Dist-tags

Every fork version is a semver **prerelease** — the `-fork.N` suffix guarantees it — so npm refuses to publish it without an explicit `--tag` rather than silently moving `latest`.

That tag is `latest`, and it has to be. Trusted Publishing mints a **publish-scoped** credential: the tag chosen at publish time is the only one CI can ever apply, and a follow-up `npm dist-tag add` is answered with a `401`. Publishing under a per-release `fork-N` tag instead would strand `latest` on whichever build shipped first.

The workflow still attempts a `fork-N` tag afterwards, best-effort and never fatal, so it starts working the day a token with dist-tag permission exists. Nothing depends on it: pinning a build works by exact version either way.

```
npm view @plebeiantech/lat.md dist-tags
```

#### Why mise needs a settings exclude

`mise use -g npm:@plebeiantech/lat.md@latest` resolves through npm's `latest` dist-tag, and mise applies two filters of its own before it will accept a version.

Only one of them bites. `prereleases` defaults to false and hides every `-fork.N` build from `mise ls-remote`, but an explicit `@latest` resolves through the dist-tag and is unaffected. `minimum_release_age` is the real obstacle: it quarantines anything published within roughly the last day, stable releases included, so a new fork build is invisible until the window passes.

`minimum_release_age_excludes` waives it for one package. That is preferable to setting `prereleases` globally, which would apply to every tool mise manages.

#### Plugin distribution

The Claude Code plugin is installed from this repository, which is its own marketplace: `.claude-plugin/marketplace.json` lists one plugin with `"source": "./"`.

```
/plugin marketplace add PlebeianTech/lat.md
/plugin install lat-md@lat-md
```

Installed user-scoped, its hooks fire in every project on the machine, and `/plugin update` pulls new versions.

The plugin ships **hooks only** — no `dist/`. A built CLI needs its runtime `node_modules` beside it, which no plugin repository should carry, so [[src/cli/hook.ts]] is reached through a separately installed binary rather than one bundled with the hooks.

`hooks/lat-guard.sh` resolves that binary from two sources in order: a `dist/` beside the plugin, which means the plugin is running out of a development checkout of this fork; otherwise `lat` on `PATH`, accepted only if `lat --version` contains `-fork`.

That check is the reason the version suffix exists. An upstream CLI answers `hook claude UserPromptSubmit` perfectly happily and without any of the checks these hooks assume, so a session would look grounded while running none of them — worse than the hook not firing at all.
