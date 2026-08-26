---
lat:
  require-code-mention: true
---
# Untrusted Text Additional Coverage

Additional coverage for [[src/untrusted.ts]] beyond its original core tests: wider invisible-Unicode stripping and the `cleanUntrustedId` helper for values embedded into ids and headings rather than quoted prose.

Tests in `tests/untrusted.test.ts`.

## Additional invisible-character ranges

`cleanUntrusted` strips a wider set of invisible Unicode than the original control-character ranges.

### Removes invisible mathematical/word-joining operators U+2060-U+2064

Every codepoint in the U+2060-U+2064 range is stripped.

### Removes the soft hyphen and the combining grapheme joiner

The soft hyphen and combining grapheme joiner characters are stripped.

### Removes a hidden instruction encoded in the Unicode Tags block

An entire hidden-ASCII payload smuggled via the Unicode Tags block (U+E0000 range) — invisible to a human reader but fully decodable — is stripped in full.

### Strips Tags-block characters without splitting surrogate pairs

Truncating or stripping a Tags-block character near a length boundary never leaves a lone surrogate half in the output.

### Removes the Arabic Letter Mark U+061C

U+061C is stripped along with the other bidi controls. It only reorders neutral characters, so it is weaker than U+202E, but an enumerated blocklist that omits it has a hole.

## cleanUntrustedId

`cleanUntrustedId` cleans a value destined for an id or heading — no quoting, no truncation cap — as opposed to `quoteUntrusted`'s display-oriented cleaning.

### Strips control characters and hidden Unicode without quoting or truncating

Control characters and hidden Unicode are removed; the surrounding text is otherwise returned unquoted.

### Does not wrap the result in quotes

A clean id-shaped string (e.g. `lat.md/notes#Heading`) passes through unchanged and unquoted.

### Does not truncate text longer than the quoteUntrusted default cap

A string longer than `quoteUntrusted`'s default truncation length is returned in full.

### Removes a control character from a heading

A newline inside a heading-shaped string is removed so it cannot break the surrounding block structure.

### Is safe on empty input

An empty string input returns an empty string.

### Neutralizes a closing wiki-link delimiter so a heading cannot escape the rendered link

A heading containing `]]` would otherwise close the generated `[[...]]` early, leaving the rest of the heading in the prompt with no untrusted framing. Square brackets are replaced so no id can break out.

## Structural delimiters in body prose

The delimiter pass covers quoted body prose, not only ids — see [[untrusted-content#Sanitization#Structural delimiters]]. These tests pin the escape it prevents and the two Markdown routes that deliver it.

### Neutralizes angle brackets so quoted prose cannot forge a container close

Quoted prose carrying `</lat-context>` followed by a fresh opening tag would close the container the untrusted notice bounds and present the rest as trusted. No angle bracket survives quoting.

### Neutralizes a backslash-escaped close tag delivered through the markdown parser

A backslash escape is one of two ways a close tag reaches a section's first paragraph as literal text rather than an inline HTML node the parser drops. The parsed paragraph really carries the tag, and quoting removes it.

### Neutralizes a close tag delivered inside an inline code span

An inline code span is the other route: its content is preserved verbatim through parsing. The parsed paragraph really carries the tag, and quoting removes it.

### Neutralizes wiki-link brackets and the alias pipe in quoted prose

Body prose cannot forge a `[[ref|alias]]` that reads as a resolved reference: brackets become parentheses and the alias pipe becomes a slash.

### Replaces delimiters one for one so the length cap is unchanged

Each delimiter maps to exactly one replacement character, so a string of delimiters truncates at the same offset as ordinary text and the cap needs no adjustment.

### Leaves the raw cleaner alone for the Markdown index path

`cleanUntrusted` returns brackets and pipes untouched. Its one raw caller is the generated Markdown index, which escapes its own labels, and pinning that boundary keeps the delimiter pass from drifting into a path that does not want it.
