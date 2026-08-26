---
lat:
  require-code-mention: true
---
# Frontmatter Field Placement

Tests for `parseFrontmatter`'s validation of known `lat` fields written at the document root instead of nested under `lat:`, and the `checkFrontmatter` check that surfaces it via `lat check`.

A field written at the document root was silently accepted by the regex-based frontmatter reader that lat-t1y.1 replaced. The stricter parser stops reading it, and because the field most often placed there turns a validation on, the failure is silent and fails open — the tree behaves as if the field were never set.

Tests in `tests/lattice.test.ts` (`parseFrontmatter`) and `tests/lattice.test.ts` (`checkFrontmatter`).

## parseFrontmatter reports misplaced fields

`parseFrontmatter` returns a `problems` array describing any known `lat` field found at the document root.

### Reports a known lat field written at the document root

A recognized field (e.g. `require-code-mention`) written directly under the top-level frontmatter, not nested under `lat:`, produces a `root-level-field` problem naming it, and the field itself is not read.

### Reports nothing when the field is nested under lat

The same field written correctly under `lat:` produces no problems and is read normally.

### Reports nothing for a root key that is not a lat field

An arbitrary root-level key that happens not to be a recognized `lat` field name produces no problems — only known fields are flagged.

### Reports nothing for a document with no frontmatter

A document with no frontmatter block at all produces no problems.

### Covers every known field, not just one

Every field in `LAT_FIELDS` is checked individually: written at the document root, each produces its own `root-level-field` problem.

## parseFrontmatter reports malformed YAML

Losing the whole frontmatter block to one bad line is the same class of failure by another route — every `lat` field in the document silently stops being read.

### Reports frontmatter that is not valid YAML instead of swallowing it

Frontmatter containing an unparseable line produces a `parse-error` problem, and no `lat` field from the block is read.

## checkFrontmatter over fixture trees

Functional tests running `checkFrontmatter` against fixture `lat.md/` directories.

### Names the field and shows the nested form as the fix

A tree with a root-misplaced field produces exactly one error naming the field and showing the correct `lat:`-nested form.

### Passes the nested form and an unrelated root key

A tree with the field correctly nested, and a tree with only an unrelated root-level key, both produce no errors.

### Reports a malformed block rather than losing the field in silence

A tree with unparseable frontmatter YAML produces exactly one error saying the block is not valid YAML.
