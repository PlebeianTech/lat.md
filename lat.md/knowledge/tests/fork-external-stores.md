---
lat:
  require-code-mention: true
---

# Fork External Stores

Tests in [[tests/knowledge/external.test.ts]] for [[src/knowledge/external.ts]],
which runs the knowledge stores registered in the user's lat config. Each test
writes a small Node script as the store and registers it in a config file in a
temporary `XDG_CONFIG_HOME`. See [[knowledge-federation#External stores]].

## A registered store appears under its label after the built-ins

[[src/knowledge/index.ts#DEFAULT_STORES]] lists the registered store after
`cq`, `bd` and `claude-memory`. Its hits appear in
[[src/knowledge/index.ts#federateTags]] output under its cleaned label, after
the built-in groups.

## Bad output yields no hits from that store

Output that is not JSON, an array of wrongly shaped values, or a JSON object
gives no group for that store. A built-in store's hits still appear.

## Wrongly shaped hits are dropped and the rest capped at the limit

An object without a number `score` is dropped. The well-shaped hits are kept
in order, up to the query's `limit`.

## A non-zero exit yields no hits

A store that prints valid hits but exits with status 1 gives no hits.

## A store past its timeout is abandoned

A store that never answers is abandoned and killed soon after its
`timeout_ms`.

## The federation deadline kills a store child

A store with `timeout_ms` 10000 that never answers is killed when the
federation deadline passes. The test ends well before the store's own timeout.

## An invalid config leaves the built-ins working

A `config.json` that is not valid JSON leaves only the three built-in stores,
and the process does not exit.

## Malformed and built-in named entries are ignored

An entry named `bd`, an invalid name, a missing label, an empty command, a
store without the `query` operation, and a repeated name are all skipped. The
only `bd` store is the built-in one.

## The test environment hides the user config

Under the vitest environment, `XDG_CONFIG_HOME` is an empty temporary
directory, so [[src/knowledge/index.ts#DEFAULT_STORES]] returns only the
built-ins whatever the developer registered.

## Terms reach the store verbatim with no shell

A term such as `$(touch pwned)` reaches the store unchanged inside the stdin
JSON request, and no file named `pwned` is created.
