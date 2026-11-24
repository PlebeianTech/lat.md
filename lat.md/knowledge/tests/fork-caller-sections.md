---
lat:
  require-code-mention: true
---

# Fork Caller Sections

Tests in [[tests/knowledge/caller-sections.test.ts]] for [[src/knowledge/caller-sections.ts#findSectionsLinkedToSymbols]], which finds the sections linked to code symbols.

## Comment above the symbol links its section

A `@lat:` comment on the line directly above a function ties its section to that function.

## Comment inside the symbol links its section

A `@lat:` comment inside a function body ties its section to that function.

## Wiki link to the symbol links its section

A section whose text holds a source wiki link to the file and symbol is linked to that symbol.

## Other symbols in the same file are not linked

Sections tied only to a different symbol in the same file are left out.

## Unknown files and symbols give nothing

Missing files, missing symbols and a missing project give an empty list without throwing.

## Sections of several symbols are deduplicated

A section tied to more than one of the given symbols is listed once.

## A given run context is reused

Given a `CheckRunContext`, the lookup uses the code refs that context already scanned instead of scanning again, so the Stop hook does not analyse the project twice. Without one it scans the project afresh.
