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

Every shape that can hold a mapping key gains one: a `lat:` mapping, a flow mapping on the `lat:` line, an anchored mapping, a bare `lat:` beside a sibling list, frontmatter with no `lat:` key at all, and a block closed with `----`. Comments survive.

[[src/cli/fork-scaffold.ts#planRequireMode]] parses and re-emits through the YAML document API rather than editing lines. Line surgery has to answer from raw text every question the parser already answers — where the block ends, which indented lines are this mapping's children rather than the next key's, whether the value on the `lat:` line is a flow mapping or an anchor — and each wrong answer was its own defect. A flow mapping and an anchor were refused although both merge cleanly; a bare `lat:` beside `authors:` was refused because the scan for the first child walked out of the block and found `- ada`; a block sequence produced frontmatter that no longer parsed at all.

The `----` case is the sharpest, because nothing failed. The fence pattern here required the closing marker to end its line and [[src/lattice.ts#parseFrontmatter]]'s did not, so one reader saw frontmatter and the other saw none — and a second block was prepended above a live one. The original stayed in the file, still looking authoritative, with every field it declared silently no longer read. The two patterns are now the same pattern.

## An explicit answer is left alone

`require-mode: false` is an answer, not an absence: it is never overwritten and never re-offered. `true` is equally final, and neither is asked about again.

## A shape it cannot edit is refused rather than corrupted

`lat:` holding a list or a plain scalar is returned unchanged, because neither can carry a mapping key, and frontmatter that does not parse is named rather than edited.

Across the whole corpus no field read before the edit reads differently after it, and no document that parsed stops parsing. That is the invariant, and it is stronger than "the output parses" — a merge that sets `require-mode: true` and drops `require-code-mention: true` parses perfectly, turns one check on and another silently off, and leaves `lat check` passing on a document that used to be enforced. Two backstops in `planRequireMode` enforce it directly. Neither has a known input that reaches it under the document API, and that is the point of a backstop: they are not redundant with the shape tests above and must not be removed on the grounds that deleting them keeps the suite green.

## A root-level flag does not count as set

`require-mode: true` written at the document root leaves [[src/cli/fork-scaffold.ts#requireModeState]] `unset`, and stamping moves the key under `lat:` rather than writing a second one beside it.

Moving rather than shadowing, because [[cli#check#Frontmatter placement]] reports a misplaced field only while `lat:` lacks it. Writing the nested key ends that report, so a stray key left behind would be dead and, from then on, unmentioned by anything.

## A flag value that is neither true nor false is reported

`require-mode: yes` is a string to a YAML 1.2 parser, and [[cli#check#mode]] reports it rather than guessing.

The gate enforces on `=== true`. Anything looser in the reader used by `lat init` disagrees with the reader used by the checker: `yes` counted as "already set", so the offer went quiet and nothing was ever enforced. Both now read the same four states, and the one value that means neither thing is an error rather than a silent off.

## Existing frontmatter and listings are left alone

A root index that already links one mode directory still gets the other three, and listing twice is the same as listing once.

Testing the four together let one existing link suppress all of them, which left three directories that no index pointed at — turning a passing `lat check index` into a failing one on a tree the run had just created.

## Nothing is restructured when the gate cannot land

A root index the gate cannot be written into leaves the tree untouched: no directories, no listing, no rewrite.

Half-adoption is worse than none in both directions. Directories plus a listing without the flag reads as adopted to `checkMode`, which then passes and never mentions it; directories without the listing fails `lat check index` instead, over four directories the user never asked for.

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

Whether the flag *can* be written is settled before the question is asked. Asking first and discovering afterwards cost one tree four directories and a rewritten index in exchange for a gate that never landed, and told the user in the same breath that nothing could be edited.

## Declining is remembered

A refusal is recorded in `lat.md/.cache/lat_fork.json`, and a later run neither asks nor prints anything.

The marker is fork-owned rather than a field on upstream's `lat_init.json`, which keeps the record free of an edit to `src/init-version.ts`. Writing it also drops a `.gitignore` into `.cache/` that ignores everything: `lat.md/.gitignore` covers the cache, but only the run that *creates* `lat.md/` writes that file — and this path exists for the trees `lat init` did not create. Committed, the marker would tell every other clone that this project had already declined.

## Without a TTY the offer prints the edit instead

A non-interactive run prints the frontmatter block to paste and changes nothing, and — unlike a refusal — records nothing, so a later interactive run still offers.

A prompt with no terminal to answer it would be taken as a yes by the caller's `ask`, which returns true whenever readline is absent.

## A tree that already opted in is not asked

A root index that already declares `require-mode`, whatever its value, produces no output at all.

## An unsupported shape is never asked about

A root index whose frontmatter cannot take the flag is never prompted for, changes nothing, and records nothing — and repairing that frontmatter is enough for the very next run to offer.

Recording it stopped the prompt and stopped the recovery with it: a user who did exactly what the printed message asked was met with silence, because nothing in the tool ever cleared the marker. A defect the user can fix should be reported every run until they fix it. Only an *answer* is worth remembering.

## Every editable shape is asked about once

Each of the eight mergeable root-index shapes prompts exactly once over three runs and ends with the flag readable through the `lat:` mapping.

## The count is what adoption would newly cost

[[src/cli/fork-scaffold.ts#offerRequireMode]] runs [[cli#check#mode]] twice — once as if the gate were on, once as if off — and reports the difference.

A second copy of the classification drifted from the checker immediately. It skipped every document inside a mode directory before reading what that document declared, so two files with byte-identical frontmatter were counted or not according to where they sat: one offender advertised against two errors. Running the checker itself makes the number true by construction, and it excludes documents that are already errors — those cost nothing to adopt, because they fail either way.
