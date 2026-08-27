---
lat:
  require-code-mention: true
---

# Fork Scaffold

Tests for [[src/cli/fork-scaffold.ts]], which gives a freshly created `lat.md/` the four Diátaxis directories, and for the `require-mode` gate in [[src/cli/check-mode.ts#checkMode]] that the scaffold turns on.

Tests in `tests/fork-scaffold.test.ts`. The scaffold and the gate are tested together because neither is worth much alone: structure without a gate is a suggestion, and a gate without structure is an error message with nowhere to point.

## A fresh tree gets four mode directories

Each of `tutorials/`, `how-to/`, `reference/` and `explanation/` is created with an index, and `checkMode` finds no errors in the result.

The indexes are written to the rule each will be checked against rather than to one house style — the tutorial index carries ordered steps and a stated outcome, the reference index carries no second paragraph. A scaffold that fails its own check teaches the wrong lesson on the first run.

## The gate is stamped into the root index

The scaffolded root index gains `require-mode: true` frontmatter and a listing of the four directories, above the template lead it already had.

The listing is not decoration: without it `lat check index` reports four missing entries on a tree `lat init` has just created.

## The flag merges into frontmatter that already exists

A `lat:` mapping gains `require-mode` as a sibling at the indentation its existing children use; frontmatter with no `lat:` key gains the mapping; a root index that already declares the field, at any value, is untouched.

Bailing on any existing frontmatter — the first version — produced a silent no-op. A root index carrying `lat: tags: [...]` could never opt in, and `lat init` re-offered on every run because the flag it thought it had written was not there. The indentation case matters for the same reason: two-space children under a four-space mapping is a YAML error, not a formatting quibble.

## A flow mapping is refused rather than corrupted

`lat: {tags: [x]}` on one line is returned unchanged, because a line-based insert would break it.

The caller checks whether the flag actually landed and prints the manual edit when it did not, so the refusal is visible rather than a loop.

## Existing frontmatter and listings are left alone

A root index that already links a mode directory is not listed a second time, and listing twice is the same as listing once.

## Successive runs converge

Three scaffolds over one tree leave the root index byte-identical to what the first produced: one frontmatter block, one `require-mode` line.

## Re-scaffolding keeps a directory the user changed

A mode index that already exists on disk keeps its content.

## A flat document fails once the gate is on

With `require-mode: true` in the root index, a document that neither declares a mode nor sits in a mode directory is one error naming all four directories.

## A declared mode satisfies the gate without moving the file

A flat document carrying `mode:` under its `lat:` frontmatter passes. The gate asks for a mode, not for a directory.

## Directory indexes are never asked for a mode

The root index and every subdirectory index pass regardless of the flag, because an index is navigation rather than content.

## A tree without the flag is unchanged

A root index with no `require-mode` line leaves flat documents passing, which is what keeps this repository's own flat tree green and lets an existing project adopt the rule when it chooses.

## An existing tree is offered the gate

A tree `lat init` did not create is asked whether to turn `require-mode` on, and answering yes stamps the flag, creates the missing mode directories, and leaves both existing documents reported by [[cli#check#mode]].

The count is shown before the question. Turning the gate on is a decision about how much restructuring to take on, and it cannot be made without knowing the number.

## Declining is remembered

A refusal is recorded in `lat.md/.cache/lat_fork.json`, and a later run neither asks nor prints anything.

The marker is fork-owned rather than a field on upstream's `lat_init.json`, which keeps the record free of an edit to `src/init-version.ts`. `.cache/` is already ignored by the scaffolded `.gitignore`.

## Without a TTY the offer prints the edit instead

A non-interactive run prints the frontmatter block to paste and changes nothing, and — unlike a refusal — records nothing, so a later interactive run still offers.

A prompt with no terminal to answer it would be taken as a yes by the caller's `ask`, which returns true whenever readline is absent.

## A tree that already opted in is not asked

A root index that already declares `require-mode`, whatever its value, produces no output at all.

