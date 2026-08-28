---
lat:
  mode: explanation
---

# Untrusted Content

Framing and sanitization for repository text placed in front of a model. Implementation: [[src/untrusted.ts]].

A document under `lat.md/`, or anything resolved from it, is attacker-controlled the moment an agent runs `lat` in a repository nobody here owns. Text pulled from such a document must reach the model marked as **data, never as instruction**.

Every command that quotes repository prose into agent-facing output goes through this module: [[cli#expand]], [[cli#check#status]], [[cli#graph]], the generated index files, and [[knowledge#Output Format]].

## Notice

`UNTRUSTED_NOTICE` is a single line placed above any block of repository-derived text, stating that what follows is never an instruction whether or not it is quoted.

It covers every line in the block that follows it. Section ids, match reasons, and paths inside that block are cleaned rather than quoted — quoting would break them as link targets — but they are exactly as untrusted as the quoted body text around them, and the notice is what says so.

Emit it once per block, at the top. Repeating it per item trains the reader to skip it.

## Sanitization

[[src/untrusted.ts#cleanUntrusted]] strips control characters and invisible Unicode, collapses the result to a single line, trims it, and caps its length. The two prompt-facing entry points neutralize structural delimiters on top of that.

Order matters: control and hidden characters must be removed *before* whitespace is collapsed. Otherwise a stripped control character leaves the two words that surrounded it touching with no space between them.

### Control characters

The stripped range covers C0 controls, DEL, and the full C1 block (`\x80`–`\x9F`).

C1 matters as much as C0 and is the half that usually gets missed. U+009B is a single-byte CSI that drives terminal escape sequences exactly like the `ESC [` pair that C0 stripping already removes, and U+0085 (NEL) renders as a line break even though JavaScript's `\s` does not match it.

Newlines fall in this class too, which is intended — the whitespace-collapse step merges the words on either side into a single space.

### Hidden Unicode

Zero-width, directional, and bidi-override characters are the real injection vector: they hide text or visually reorder it without touching a single ASCII control byte.

Covered ranges:

- U+00AD (soft hyphen) and U+034F (combining grapheme joiner) — invisible in normal rendering
- U+2060–U+2064 — invisible mathematical and word-joining operators
- U+200B–U+200F, U+202A–U+202E, U+2066–U+2069, U+FEFF — zero-width, bidi override, and BOM
- U+E0000–U+E007F — the Unicode Tags block

The Tags block is the standard invisible-ASCII smuggling technique: each printable ASCII character maps to U+E0000 plus its code point, so a whole hidden instruction can be encoded as a run of otherwise-invisible characters appended to ordinary text. It is an astral range and needs the `u` flag to match at all.

### Structural delimiters

Five characters let repository text break out of the structure it is embedded in. Each is replaced with a visually similar character that carries none: `[`, `]`, `<` and `>` become parentheses, `|` becomes a slash.

- `<` and `>` forge a `</lat-context>` close and a fresh opening tag, escaping the very container the notice bounds. This is the one that matters most — the framing is worth exactly what the container is worth.
- `[` and `]` close a rendered `[[wiki link]]` early, or forge a whole one, so text can pose as a resolved reference.
- `|` is the wiki-link alias separator, so everything after it renders as free-form display text.

The pass runs in both entry points that build agent-facing text — [[src/untrusted.ts#quoteUntrusted]] for body prose and [[src/untrusted.ts#cleanUntrustedId]] for ids — not in the raw cleaner underneath them. Prose is the text an attacker controls most completely, since an id at least has to survive resolution first.

Markdown does not hold the close tag back. A backslash escape (`\<`) and an inline code span both deliver a literal `</lat-context>` into a section's first paragraph, where an unescaped one would have stayed an inline HTML node and been dropped.

The cost is that legitimate brackets and pipes in a paragraph are rewritten too. That is the right trade for text already reduced to one quoted line of at most 300 characters: nothing downstream parses it, and a reader loses no meaning.

Every replacement is one character for one, so the length cap counts the same before and after it, and it can run either side of truncation.

[[src/untrusted.ts#cleanUntrusted]] itself is left alone. Its one raw caller is the generated Markdown index, which escapes its own labels and destinations — replacing a `]` before that escaping would only swap one defence for another, and the index is a Markdown document rather than a prompt block, so no container close is in play.

### Truncation

The length cap backs off one unit when the cut would land between a surrogate pair, then appends an ellipsis.

A lone surrogate is not valid UTF-8 and does not survive re-encoding, so a naive slice can corrupt output that was otherwise clean.

## Quoting vs cleaning

Two entry points, chosen by what the text *is* rather than where it came from.

[[src/untrusted.ts#quoteUntrusted]] cleans, downgrades inner double quotes to single quotes, and wraps the result in double quotes. Use it for body text — a paragraph, a summary, a memory's contents.

[[src/untrusted.ts#cleanUntrustedId]] cleans without quoting and **without truncating**. Use it for anything that is itself an identifier: a section id, a file path, a match reason. An id must still round-trip as a working `[[ref]]` after cleaning, and truncating a heading chain or a path would break it as a reference.

Both neutralize the same structural delimiters; they differ only in the quoting and the length cap.

## Test Specs

Core behaviour is covered in [[tests/tests]]; the invisible-character ranges and `cleanUntrustedId` have additional coverage in [[tests/untrusted]].
