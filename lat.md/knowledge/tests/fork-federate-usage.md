---
lat:
  require-code-mention: true
---

# Fork Federate Usage

Tests in [[tests/knowledge/federate-usage.test.ts]] for the usage events
that [[src/knowledge/index.ts#federateTags]] writes per store query, and for
how aggregation treats them. See [[knowledge-federation#Usage Events]].

## Each store query writes one event

With `LAT_USAGE=1`, federating one document across two fake stores writes
two events, `federate:cq` and `federate:bd`.

Each has surface `hook`, caller `hook-injected`, the document id as
`section_id`, the joined terms as `query`, and the store's hit count as
`result_count` and `found`.

## A query the deadline abandons writes one deadline event

A store that outlasts the deadline gets one event at the deadline with
`error_class` `deadline`. When it settles later, it writes nothing more.

## Tracking off writes nothing

With usage tracking off, federation creates no `.lat` directory and no
events file.

## A failed write leaves federation unchanged

With an unwritable `.lat/usage` directory, federation does not throw and
returns the same output as with tracking off.

## Federation events are not injections

A usage directory with one hook event and two `federate:` events counts one
injection. Savings counts no uncaptured injected bytes for the `federate:`
events.

## Federation events are not reads

A `federate:` event inside a session's time window is not a read of its
`section_id`, so missed knowledge reports the section as never consulted.
A `federate:` event outside every session window does not count as
unjoinable.
