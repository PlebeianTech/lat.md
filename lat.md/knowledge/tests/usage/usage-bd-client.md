---
lat:
  require-code-mention: true
---

# Usage bd Client

Tests in `tests/usage-bd-client.test.ts` for `beadsDirFingerprint` in `src/fork/usage/bd-client.ts`. They build a fake bd store in a temporary directory.

## A lock file does not blank the fingerprint

A real store holds a `.lock` file beside its databases in `embeddeddolt/`. Entries with no `.dolt/noms/manifest` are skipped, so the fingerprint is still non-empty.

## The fingerprint follows manifest content, not mtime

Every bd command, read-only ones included, rewrites the manifest with the same bytes and a new mtime. That keeps the fingerprint, so the live poll does not see its own bd calls as a change. New manifest bytes change it.

## An unreadable store gives an empty fingerprint

An unset `BEADS_DIR` or a store with no `embeddeddolt/` directory gives '', which the watcher treats as changed.
