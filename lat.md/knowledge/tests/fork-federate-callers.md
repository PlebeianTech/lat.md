---
lat:
  require-code-mention: true
---

# Fork Federate Callers

Tests in [[tests/knowledge/federate-callers.test.ts]] for the callers group
that [[src/knowledge/index.ts#federateTags]] adds under a document, using
[[src/knowledge/linked-symbols.ts#linkedSymbols]]. Each test registers the
fixture provider `tests/fixtures/callers-provider.cjs` in a config file in a
temporary `XDG_CONFIG_HOME`. See [[knowledge-federation#Output Format#Callers in output]].

## Callers of a linked symbol are listed after the store hits

A document that links `[[src/a.ts#foo]]` gets a `Callers (LABEL):` group with
the provider's callers of `foo`, after its store groups. The label is cleaned
like any other untrusted id.

## Only source symbol links are sent to the provider

A bare source link, a section link and a markdown link with a `#` are not
sent. A source link with a nested symbol such as `Klass#method` is.

## A document sends at most ten symbols

A document that links twelve symbols sends the first ten, in link order.

## A symbol linked twice is sent once

A document that links `[[src/a.ts#foo]]` twice sends `foo` once, so the
repeat does not spend one of its ten symbol slots.

## A shared caller is shown once

When two symbols of a document have the same caller, the caller line appears
once and spends one caller slot.

## A document shows at most three callers

When the provider returns five callers for a symbol, three are shown.

## Caller lines count against the total hit cap

Caller lines spend `maxTotalHits` after the store hits, so the cap cuts
caller lines first.

## A full cap skips the provider

When the store hits use the whole cap, the provider is not run.

## Without a provider the output is unchanged

With no callers provider, or only a provider without the `callers` operation,
the output has no callers group.

## A late provider leaves the other groups intact

A provider that outlasts the federation deadline yields no callers group,
and the store groups are unchanged.

## A document without store hits is not shown for its callers

A document with callers but no store hits is not emitted, and the provider
is not run.
