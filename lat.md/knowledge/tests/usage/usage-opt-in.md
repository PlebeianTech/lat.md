---
lat:
  require-code-mention: true
---

# Usage Opt-in

Tests in `tests/usage-opt-in.test.ts` for the opt-in rule in [[usage-analytics#Usage Analytics#Opt-in and the usage directory]].

Each test runs on a fresh git repository with a `lat.md` directory and no `.lat/`. The default session sources are replaced by one fake source that counts its reads, so no test reads the real machine.

## The aggregator reads nothing and writes nothing when off

On a project that is not enabled, a summary reads no session store, counts no token messages and leaves no `.lat/` directory.

## LAT_USAGE alone keeps state in memory

With `LAT_USAGE=1` and no `.lat/usage/`, the aggregator reads the session store and counts its events, and still leaves no `.lat/` directory.

## Graph snapshots are built without a cache when off

`snapshotAt` on a project that is not enabled builds the snapshot of the head and writes no cache.

## The raw event index reads nothing when off

The raw event index returns no records, reads no session store and leaves no `.lat/` directory.

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

`lat usage enable` writes `.lat/usage/.gitignore` holding `*`, so `git status` shows nothing new. On a directory that already exists without one, enable adds it.

## Saving state adds a missing ignore file

Saving state into an existing `.lat/usage/` that lacks `.gitignore` adds it, so `git status` stays clean. With `LAT_USAGE=1` and no directory, saving state writes nothing.
