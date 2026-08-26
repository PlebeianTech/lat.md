---
lat:
  require-code-mention: true
---
# Check Index

Tests for validating `lat.md/` directory index files and subdirectory index files.

## Detects missing index file

Given a `lat.md/` directory with files but no index file (`lat.md`), `checkIndex` reports a missing-index error and includes a bullet-list snippet covering all visible entries.

## Passes with valid index

Given a `lat.md/` directory whose index file lists all visible entries with descriptions, `checkIndex` returns no errors.

## Detects stale index entry

Given an index file that lists a file which does not exist on disk, `checkIndex` reports it as a stale entry.

## Detects missing subdirectory index file

Given a `lat.md/` directory with a subdirectory containing files but no index file for that subdirectory, `checkIndex` reports a missing-index error with a snippet listing the subdirectory's entries.

## Passes with valid subdirectory index

Given a `lat.md/` directory where both the root and a subdirectory have correct index files listing all visible entries, `checkIndex` returns no errors.

## Detects stale subdirectory index entry

Given a subdirectory index file that lists a file which does not exist on disk, `checkIndex` reports it as a stale entry.

## Detects non-markdown file

Given a checked directory containing a file without a `.md` extension (e.g. `README`), `checkIndex` reports it as an error since only markdown files belong in the documentation directory.

## Non-markdown files excluded from index listing

Non-`.md` files do not appear in missing-entry suggestions or index snippets — only markdown files participate in index validation.

## check --fix regenerates index files

`checkIndex(lat, { fix: true })` and the equivalent `lat check --fix`/`lat check index --fix` CLI flags regenerate stale or missing index files from frontmatter instead of merely reporting them, per [[cli#check#index]].

### lat check --fix repairs a failing tree end to end

Running `lat check --fix` against a tree with a missing index file, then a plain `lat check`, passes — the acceptance criterion is that the top-level command's own `--fix` flag is sufficient, not just `lat check index --fix`.

### Writes a missing index that then passes

`checkIndex(lat, { fix: true })` on a tree with no index file at all writes one containing a link to the tree's file, and a subsequent `checkIndex` call with no `fix` option returns no errors.

### Regenerates a subdirectory index before its parent

`checkIndex(lat, { fix: true })` regenerates a stale subdirectory index before regenerating its parent, so the parent's fixed listing reflects the subdirectory's final state.

### Escapes a title shaped like a closing bracket

A document title containing `]` and `(` produces exactly one Markdown link on its generated index line, with those characters backslash-escaped rather than closing and reopening the link.

### Links to a file whose name contains a percent-encoded paren

A generated index entry for a file whose name already contains a percent-encoded parenthesis produces a link destination that round-trips: percent-decoding it resolves back to the real file on disk.

## Generated index write guard

`writeGeneratedIndex` must never write through a symlink at the index path or at its temporary write path, and must otherwise write the index normally, per [[cli#check#index]].

### Symlink at the index path

If the index path is a symlink, `writeGeneratedIndex` refuses to write, reports the refusal instead of skipping silently, and leaves the symlink's target file unmodified.

### Symlink pre-planted at the temp path

If a symlink already exists at the temporary path `writeGeneratedIndex` would use before renaming into place, the write is refused and the symlink's target is left unmodified.

### Normal non-symlink case

When neither the index path nor its temporary write path is a symlink, `writeGeneratedIndex` writes the regenerated index content correctly.

## Directory index entry parsing

`parseIndexEntries` reads generated (`- [Title](name)`) and legacy wiki-link (`- [[name]]`) bullets from an index file, and must not confuse an external link for either, per [[src/cli/link-scheme.ts#isLatticeLocalDest]].

### External link bullets are ignored

A bullet whose destination carries a URL scheme, such as `- [See upstream docs](https://example.com/docs)`, is skipped entirely rather than being parsed as an entry named after its scheme (e.g. `https:`).

### Generated and legacy wiki-link entries still validate

An index file mixing an external link, a generated entry (`- [Notes](notes.md)`), and a legacy wiki-link entry (`- [[page]]`) still validates the generated and wiki-link entries against the files on disk.

### A bare scheme-shaped filename is treated as external

A destination like `weird:name.md` matches the URL-scheme grammar despite having no `/` before the colon, so it is treated as external, consistent with `localLinkTarget` elsewhere in this file.

### Destination shapes that are not child names

A destination's first path segment is not automatically a child name: `./notes.md` names `notes.md`, `page.md#intro` names `page.md`, and `../outside.md` names no child at all, per [[src/cli/link-scheme.ts#indexEntryNameFromDest]].

## Splicing preserves hand-written content

`spliceIndexContent` rewrites only the region between `<!-- lat:index:begin -->` / `<!-- lat:index:end -->` markers, per [[src/cli/gen-index.ts#spliceIndexContent]].

### Hand-written content below the generated list survives

A section written by a person after the generated bullet list is not deleted when `--fix` regenerates the list.

### Hand-written content above the generated list survives

A leading paragraph or section written before the generated bullet list is preserved unchanged when `--fix` regenerates the list.

### A hand-written external-link bullet survives untouched

A hand-written bullet linking to an external URL is not treated as a generated entry, so it and any hand-written prose that follows it survive `--fix`.

### Running --fix twice is byte-identical

Running `--fix` a second time produces exactly the same file content and does not add a second pair of markers.

### A malformed marker pair is refused and the file is left unchanged

A begin marker with no matching end marker (or vice versa) causes `--fix` to refuse the write and report the problem, leaving the file on disk byte-for-byte unchanged.
