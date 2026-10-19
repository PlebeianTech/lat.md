---
lat:
  require-code-mention: true
---
# Status

Functional and unit tests for the `status`/`reviewed-hash` provenance fields, `lat check status`, and the provenance note surfaced above a quoted section.

Tests in `tests/status.test.ts`.

## Provenance line in section output

`formatSectionOutput` inserts a one-line provenance warning above the quoted body, computed from the document's frontmatter.

### Warns that an agent-extracted document is unreviewed

A document with `status: agent-extracted` prints `[unreviewed -- written by an agent, not checked by a person]` above its quoted body.

### Adds no line for a document with no status

A document with no `status` field at all gets no provenance line inserted — the blank line between the header and the quoted body is unchanged.

### Marks a human-reviewed document whose hash still matches

A `human-reviewed` document whose `reviewed-hash` still matches its current body prints `[human-reviewed]` with no staleness warning.

### Marks a stale human-reviewed document

A `human-reviewed` document whose body has changed since `reviewed-hash` was recorded prints `[stale review -- the text changed after a person checked it]`.

### Provenance line precedes the quoted content

The provenance line appears before the quoted `> #` heading line, so a reader sees the caveat before acting on the body.

## checkStatus

`checkStatus` walks a `lat.md/` tree and reports provenance errors: a stale review, an unrecognized `status` value, or nothing at all for a passing or unset document.

### Reports a stale review and names the hash to record

A stale `human-reviewed` document's error message contains "stale review" and the current hash the author should record to clear it.

### Reports nothing for a matching review

A `human-reviewed` document whose `reviewed-hash` still matches produces no errors.

### Reports nothing for a human-reviewed document with no hash

A `human-reviewed` document with no `reviewed-hash` field at all is not an error — existing trees predate the field and must not turn red on upgrade.

### Reports nothing for a document with no status

A document with no `status` field at all produces no errors.

### Reports an unrecognized status value

An unrecognized `status` string is reported as an "unknown status" error, and the message quotes the offending value as repository text.

### Reports an unrecognized status as untrusted text

`provenanceNote` strips control characters and hidden Unicode from an unrecognized `status` value before it reaches the returned note, so a hostile status string can't inject a newline or invisible instruction into check output.

## hashReviewedBody

`hashReviewedBody` hashes only the body text a review actually covers, ignoring metadata that carries no claim.

### Ignores a heading change

Renaming a section's heading does not change its body hash — a title has no claim in the reviewed prose. Only the heading's `#` marker is hashed, not its text.

### Changes when a heading is appended

Appending a new heading changes the hash, so a review cannot stay valid across a section an agent added. Retitling stays invisible because the marker sequence is unchanged; adding or removing a heading alters it.

### Ignores a frontmatter change

Adding or editing an unrelated frontmatter field does not change the body hash.

### Ignores trailing whitespace

Trailing whitespace on the body text does not change the hash — it's invisible in a diff and shouldn't force a re-review.

### Changes when the prose changes

Editing the body text changes the hash, so a stale review is always detectable.

## lat check status

Functional tests running the built CLI's `check status` and `check` subcommands against fixture trees.

### Exits non-zero and names the stale document

`lat check status` on a tree with a stale review exits 1 and its stderr mentions "stale review".

### Exits zero on a passing tree

`lat check status` on a tree whose reviews all match exits 0.

### Turns a passing tree red once its reviewed prose is edited

Editing the body of a previously matching `human-reviewed` document, without updating `reviewed-hash`, makes `lat check status` fail — the whole point of the hash is that reviewed prose can't drift silently.

### Counts status errors in the full check total

A stale review also fails a plain `lat check` (no subcommand), not just `lat check status`.
