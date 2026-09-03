# Merging upstream

Merging is cheap when the fork's own rules have been kept. Most of the procedure is moving the sync point and re-deriving the allowlist from it.

1. **Look before merging** — `git fetch upstream`, then `git merge-tree --write-tree --name-only HEAD upstream/main` names every conflict without touching the working tree
2. **Merge** — `git merge upstream/main`, resolving what git reports
3. **Install** — `pnpm install`, since upstream may have added dependencies
4. **Move the sync point** — `--set-sync-point <the upstream commit just merged>`
5. **Regenerate the allowlist** — the baseline moved, so the set of files the fork diverges in moved with it; replace any `TODO` marker the generator writes
6. **Check the whole tree** — `pnpm typecheck`, `pnpm build`, `pnpm vitest run --dir tests`, and `lat check`

Steps 4 and 5 belong in the merge commit or the one right after it. Between the merge and the new sync point, the guard is measuring against a baseline that no longer describes anything.

## What a clean merge still breaks

A merge git calls clean is not the same as a merged tree that works, and the 0.12.2 merge produced one instance of each failure this fork has seen.

A **type widened underneath us**. Upstream added a field to what `searchSections` returns, and a fork-owned test's fixture no longer satisfied it. `pnpm typecheck` catches this; the merge itself cannot.

A **name collided**. Upstream added `lat.md/view/graph.md` while the fork already had `lat.md/tests/graph.md`. Two additions, no textual overlap, and every short-form `[[graph#...]]` reference became ambiguous — 32 `lat check` errors, two of them inside upstream's own documents, which this fork's filename had broken. Renaming the fork-owned file fixed all 32 and left upstream's links alone. See [[fork#Keeping the diff small#Name a new file something upstream would not reach for]].

The de75b80 merge added two more, both from upstream rewriting a function the fork had changed rather than the fork's own lines.

A **fork behaviour was dropped**. Upstream replaced the TypeScript scanner's read loop with a parallel one that calls `LAT_REF_RE` directly, where the fork's version called `extractRefsFromLine`. Git resolved that hunk cleanly and the tree compiled, but `lat:ignore` and the literal-example exclusion stopped applying whenever ripgrep was absent, so the two scan paths silently disagreed. Only the suite sees this: `tests/code-refs-ignore.test.ts` exercises the fallback under `_LAT_DISABLE_RG=1`.

A **fork behaviour became unsafe where it had been safe**. `lat check` used to run its validators in sequence, which is what made `--fix` rewriting index files harmless. Upstream made them concurrent over a shared parse cache, and the fork's write then raced readers holding pre-fix text. Nothing conflicted and nothing failed to compile; the merged code was simply wrong in a way that depends on scheduling. Whenever upstream changes how something runs, check what the fork put inside it.

None of the four is visible to the upstream guard, which reads paths rather than contents. The suite and `lat check` are what close that gap, which is why step 6 runs the whole tree rather than the files the merge touched.
