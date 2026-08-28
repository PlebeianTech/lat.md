# The upstream guard

A checker that compares the working tree against the sync point and fails when the diff touches an upstream file that `fork-upstream-allowlist.tsv` does not name. It is what turns [[fork#Keeping the diff small]] from prose into a build step.

The rule was broken twice in one session by agents who did not disagree with it — they were moving fast, and prose does not stop that. Mechanism does.

```
node dist/src/fork/upstream-guard-cli.js
pnpm exec tsx src/fork/upstream-guard-cli.ts
```

Both lines run the same program. The first needs `pnpm build` to have run; the second needs only `pnpm install`. `--repo`, `--sync-point`, `--allowlist`, and `--sync-point-file` override the defaults, which are the working directory, the recorded sync point, and the two files at the repository root.

A path is upstream when it resolves to a blob in the sync point's tree, so every file the fork added is invisible to the check and costs nothing. The diff is taken with `--no-renames`, which makes a renamed upstream file read as a deletion plus an addition — and a deletion is refused.

## The sync point

`fork-upstream-sync-point` records the last upstream commit merged into this fork, and every measurement the guard makes is taken relative to it.

A frozen baseline cannot work. The guard was first written against the fork point `65d2f5b`, which made it read upstream's own commits as fork divergence the moment upstream was merged — 27 violations, every one of them a file the fork had never touched. Advancing the record in the same commit as the merge is what keeps the number honest.

The same baseline decides ownership. A file upstream added after the fork point is upstream's, and a check anchored at the fork point would call it fork-owned and wave an unexplained edit through.

```
node dist/src/fork/upstream-guard-cli.js --set-sync-point <rev>
```

The revision has to be an ancestor of `HEAD` already: a sync point off the current history makes the diff meaningless, so recording one before its merge lands is refused. A shallow clone cannot answer the ancestry question at all, and skips the check rather than failing on truncated history.

## The allowlist

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

## Deletions are not allowlistable

Any deletion of an upstream file fails the check, allowlisted or not. There is no flag, no entry, and no override.

The asymmetry is the whole reason: a file this fork deletes produces a delete/modify conflict on **every** future merge that touches it upstream, while a file this fork modifies conflicts once and stays resolved. See [[fork#Keeping the diff small#Never delete an upstream file]] for what to do instead.

The regenerate path honours the same rule. It refuses to write a deletion into the list and reports it, so a deletion cannot be laundered into an exception by running the generator.

## Running it in CI

`ci.yml` runs the guard in one step, immediately after `pnpm install --frozen-lockfile` and before the build.

```
- name: Upstream guard
  run: pnpm exec tsx src/fork/upstream-guard-cli.ts --fetch
```

`actions/checkout@v4` clones with `fetch-depth: 1`, so the sync-point commit is **not** in the runner's object store and every git command against it fails. `--fetch` runs `git fetch --no-tags --depth=1 origin <sync point>` when the commit is absent, which GitHub serves for an arbitrary reachable SHA. Keeping the revision in `fork-upstream-sync-point` rather than in the workflow leaves one place for it to be wrong.

Nothing under `.github/` carries a `@lat:` pointer. `walk.ts` filters every path beginning with `.`, so no workflow file is ever scanned and a ref placed there would rot without `lat check` noticing. Workflows reference this document in prose instead.

Without `--fetch` the guard does not silently pass: it exits non-zero and prints the fetch command. That is the deliberate half of the design — the two failure modes worth avoiding are a check that always passes and a check that always fails, and a missing sync point produces neither silence nor a false accusation.

The step runs before the build so the sync point is already fetched by the time `vitest` runs, which is what lets the suite assert that this repository itself passes the guard.

## Verifying a file's ownership

Before editing anything, resolve whether upstream owns it. The question is asked at the sync point, not at the original fork point, so a file upstream added later still answers `UPSTREAM`.

```
SYNC=$(awk 'NF && $1 !~ /^#/ {print $1; exit}' fork-upstream-sync-point)
git cat-file -e "$SYNC:<path>" && echo UPSTREAM || echo fork-owned
```

The `NF` guard matters: the recorded revision sits below a blank line, so a
plain `grep -v '^#' | head -1` selects the blank and silently answers the
wrong question. `parseSyncPoint` skips blanks for the same reason.

## Watching the drift

A weekly workflow fetches upstream, trial-merges it, and reports what it finds, so the cost of the next merge is a standing number rather than a surprise.

```
pnpm exec tsx src/fork/upstream-drift-cli.ts
```

It reports how far upstream has moved past the sync point, which files it touched, which files **both** sides changed, and whether `git merge-tree` finds a textual conflict. The both-sides list is the leading indicator: those are the files the next conflict will come from, even in a week when the merge is clean.

The workflow then merges for real in the runner's checkout and runs `pnpm typecheck` and `lat check` on the result, because [[merge-upstream#Merging upstream#What a clean merge still breaks]] is not visible to `git merge-tree`. It never pushes and never writes to any remote — the upstream fetch is read-only, and nothing is posted to a repository this project does not own.

`--fail-on-conflict` turns the report into a gate. It is off by default: a conflict with upstream is information, not a broken build.
