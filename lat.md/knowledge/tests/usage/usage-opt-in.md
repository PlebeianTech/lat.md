---
lat:
  require-code-mention: true
---

# Usage Opt-in

Tests in `tests/usage-opt-in.test.ts` for the opt-in rule in [[usage-analytics#Usage Analytics#Opt-in and the usage directory]].

Each test runs on a fresh git repository with a `lat.md` directory and no `.lat/`. The default session sources are replaced by one fake source that counts its reads, so no test reads the real machine.

## The aggregator reads nothing and writes nothing when off

On a project that is not enabled, a summary reads no session store, counts no token messages and leaves no `.lat/` directory.

## The aggregator runs no bd when off

On a project that is not enabled, a summary and a refresh make no call to the bd watcher. After usage is turned on, the next refresh calls it once and the summary counts the session events.

## LAT_USAGE alone keeps state in memory

With `LAT_USAGE=1` and no `.lat/usage/`, the aggregator reads the session store and counts its events, and still leaves no `.lat/` directory.

## Graph snapshots are built without a cache when off

`snapshotAt` on a project that is not enabled builds the snapshot of the head and writes no cache.

## The raw event index reads nothing when off

The raw event index returns no records, reads no session store and leaves no `.lat/` directory.

## The raw event index runs no bd when off

On a project that is not enabled, a read of the raw event index makes no call to the bd watcher. After usage is turned on, the next read calls it once and returns the session records.

## lat usage says tracking is not enabled

`lat usage` prints that tracking is not enabled and how to enable it, with no totals and exit code 0. `--json` prints `enabled: false` with the same reason. Nothing is read or created.

## lat usage gaps says tracking is not enabled

`lat usage gaps` prints the same message. `--json` prints `enabled: false` with no findings. Nothing is read or created.

## The lat_usage tool is absent when off

The `lat_usage` MCP tool is not registered on a project without `.lat/usage/`, and registering creates nothing.

## The live endpoints serve empty data when off

`/api/usage`, `/api/usage/raw` and `/api/usage/findings` answer with no token messages, no records and no findings. They read no session store and leave no `.lat/` directory.

## Disable stays effective

After `lat usage enable`, a read, and `lat usage disable`, neither `lat usage`, `lat usage gaps` nor a fresh aggregator recreates `.lat/usage/`. A later `lat usage enable` really enables again.

## Enable writes an ignore file

`lat usage enable` writes `.lat/usage/.gitignore` holding `*`, so `git status` shows nothing new under `.lat`. On a directory that already exists without one, enable adds it.

## A committed ignore file is replaced

A repository can commit `.lat/usage/.gitignore` empty. Enable and saving state replace it with `*`, so `git add -A` stages nothing else under `.lat`. A symlink there is replaced, never written through.

## Saving state adds a missing ignore file

Saving state into an existing `.lat/usage/` that lacks `.gitignore` adds it, so `git status` stays clean. With `LAT_USAGE=1` and no directory, saving state writes nothing.

## Saving state never follows a planted symlink

A symlink planted at the state temporary file `state.json.<pid>.tmp` is removed, not followed, and the file it points to is not changed. The temporary file is created exclusively.

## Saving state survives a stale temporary file

A crash can leave `state.json.<pid>.tmp` behind. A later save with that pid removes it first, so the save still succeeds.

## Saving state refuses a symlinked usage directory

When `.lat/usage` is a symlink, saving state returns silently and writes nothing in the directory it points to.

## A symlinked .lat is not opted in

When `.lat` or `.lat/usage` is a symlink, usage is off for the project. `LAT_USAGE=1` still turns it on.

## Loading state reads only a regular file

When `state.json` is a symlink, to an outside file or to `/dev/zero`, loading state does not read it and starts from an empty state.

## Loading state drops malformed content

A `state.json` with version 2 but no maps, such as `{"version":2}`, loads as an empty state, and an aggregator refresh over it does not throw.

A stored usage event dated 3000-01-01 and a stored session event with no plausible ts are dropped on load. Valid stored events are kept.

## The event log reads only regular files

A symlinked events file is not ingested. A regular events file at the same path is.

## State keeps events whose ids look like object properties

Events with the ids `__proto__` and `constructor` in the event log are in the state after a read, and still there after the state is saved and loaded.

After the load, an event with the id `toString` can still be added.

## An unusable state.json is reported once

When `state.json` exists but is unreadable, a symlink, not valid JSON, not an object, or of another version, loading it prints one stderr message and returns an empty state. A second load prints nothing.

The message names the file and quotes nothing from it. A missing `state.json`, a usable one, and a project with no usage directory print nothing.
