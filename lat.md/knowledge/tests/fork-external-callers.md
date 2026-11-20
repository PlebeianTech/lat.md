---
lat:
  require-code-mention: true
---

# Fork External Callers

Tests in [[tests/knowledge/callers.test.ts]] for
[[src/knowledge/callers.ts]], which asks a registered external store who
calls a code symbol. Each test registers the fixture provider
`tests/fixtures/callers-provider.cjs` in a config file in a temporary
`XDG_CONFIG_HOME`. See [[knowledge-federation#External stores#Callers]].

## Callers are keyed by file and name

A provider with the `callers` operation answers for one symbol. The result is
a map from `file#name` to that symbol's callers.

## The request has the documented shape

The provider's stdin holds one JSON object with `operation`, `projectRoot`,
`symbols` and `depth`.

## Without a callers provider the result is empty

With no store, or a store whose operations lack `callers`, the result is an
empty map and the store command never runs.

## Failures give an empty result

Output that is not JSON, a non-zero exit and a timeout each give an empty
map.

## Wrongly shaped entries are skipped

An entry without a symbol or with non-array callers, and a caller without a
string file, a string name and a number line, are skipped. The well-shaped
entries stay.

## Callers outside the project are dropped

A caller whose file is absolute or has a `..` segment is dropped. The other
callers of the same symbol stay.
