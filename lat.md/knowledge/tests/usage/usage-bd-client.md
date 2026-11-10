---
lat:
  require-code-mention: true
---

# Usage bd Client

Tests in `tests/usage-bd-client.test.ts` for `resolveBeadsDir` and `beadsDirFingerprint` in `src/fork/usage/bd-client.ts`. They build a fake project root and bd store in temporary directories.

They pass the environment in, so an exported `BEADS_DIR` never leaks in.

## A lock file does not blank the fingerprint

A real store holds a `.lock` file beside its databases in `embeddeddolt/`. Entries with no `.dolt/noms/manifest` are skipped, so the fingerprint is still non-empty.

## The fingerprint follows manifest content, not mtime

Every bd command, read-only ones included, rewrites the manifest with the same bytes and a new mtime. That keeps the fingerprint, so the live poll does not see its own bd calls as a change. New manifest bytes change it.

## A planted manifest link is never read

A repository can commit a manifest as a symlink. A database whose manifest is a symlink is skipped like one with no manifest, so the fingerprint equals the one for the other databases alone. A store whose only manifest is a symlink gives ''.

## An unreadable store gives an empty fingerprint

An unresolved directory (no project `.beads/` and no `BEADS_DIR`) or a store with no `embeddeddolt/` directory gives '', which the watcher treats as changed.

## The project database wins over BEADS_DIR

`resolveBeadsDir` returns `<project root>/.beads` when that is a directory, whether or not `BEADS_DIR` is set.

## BEADS_DIR applies without a project database

With no `.beads/` directory in the project root, `resolveBeadsDir` returns `BEADS_DIR`, and nothing when it is unset or empty. A file named `.beads` is not a database directory.

## The fingerprint follows the resolved directory

The fingerprint of `resolveBeadsDir(root)` changes when the project's own database changes, even when `BEADS_DIR` names another store, and ignores changes in that other store.
