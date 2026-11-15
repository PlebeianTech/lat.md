---
lat:
  require-code-mention: true
---

# Fork Guard Nested Repo

Tests in [[tests/fork-guard-nested-repo.test.ts]] for [[hooks/lat-guard.sh]], which must not treat a git repository named `lat.md` as a docs directory.

## A nested repository named lat.md is not a docs directory

With a `lat.md/` that holds `.git`, `check index --fix` writes nothing anywhere under the project.

## A plain lat.md directory is still indexed

With a `lat.md/` that holds no `.git`, `check index --fix` still writes its missing index, so the skip rule has not disabled the hook.

## A nested repository gets the init notice

With a `lat.md/` that holds `.git`, `hook claude UserPromptSubmit` prints the notice telling the agent to run `init`.
