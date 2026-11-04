---
lat:
  require-code-mention: true
---

# Fork Prompt Search

Tests in [[tests/fork-prompt-search.test.ts]] for [[src/cli/fork-prompt-search.ts]], which caps search context enrichment in [[src/cli/hook.ts#handleUserPromptSubmit]] under [[src/cli/fork-prompt-search.ts#PROMPT_SEARCH_MAX_BYTES]] with compact section previews.

## Empty matches return null

[[src/cli/fork-prompt-search.ts#formatPromptSearchMatches]] returns `null` when the match list is empty so the hook appends no search heading or blank padding.

## Single match within budget renders full section output

When one search match fits within [[src/cli/fork-prompt-search.ts#PROMPT_SEARCH_MAX_BYTES]], [[src/cli/fork-prompt-search.ts#formatPromptSearchMatches]] loads the section via [[packages/core/src/cli/section.ts#getSection]] and renders full output with [[packages/core/src/cli/section.ts#formatSectionOutput]].

## Single match exceeding budget falls back to compact preview

When one match exceeds [[src/cli/fork-prompt-search.ts#PROMPT_SEARCH_MAX_BYTES]], [[src/cli/fork-prompt-search.ts#formatPromptSearchMatches]] downgrades it to [[src/cli/fork-prompt-search.ts#formatCompactSearchMatch]] and appends [[src/cli/fork-prompt-search.ts#NAVIGATION_HINT]].

## Single match with unresolvable section falls back to compact preview

When [[packages/core/src/cli/section.ts#getSection]] returns `no-match`, [[src/cli/fork-prompt-search.ts#formatPromptSearchMatches]] falls back to [[src/cli/fork-prompt-search.ts#formatCompactSearchMatch]] using the match metadata and appends [[src/cli/fork-prompt-search.ts#NAVIGATION_HINT]].

## Multiple matches produce compact previews without loading full sections

For multiple matches, [[src/cli/fork-prompt-search.ts#formatPromptSearchMatches]] renders compact bullets via [[src/cli/fork-prompt-search.ts#formatCompactSearchMatch]] and skips [[packages/core/src/cli/section.ts#getSection]].

## Output strictly honors maximum byte limit

[[src/cli/fork-prompt-search.ts#formatPromptSearchMatches]] caps UTF-8 output at `maxBytes` (defaulting to [[src/cli/fork-prompt-search.ts#PROMPT_SEARCH_MAX_BYTES]]).

## Truncation preserves trailing navigation hint

When candidate bullets exceed the remaining budget, [[src/cli/fork-prompt-search.ts#formatPromptSearchMatches]] omits later matches while keeping [[src/cli/fork-prompt-search.ts#NAVIGATION_HINT]] intact.

## Multi-byte UTF-8 characters are measured by byte length

[[src/cli/fork-prompt-search.ts#formatPromptSearchMatches]] measures `Buffer.byteLength` in UTF-8 rather than string character count so multi-byte sequences stay within `maxBytes`.

## Compact match formatter formats bullets and sanitizes paths

[[src/cli/fork-prompt-search.ts#formatCompactSearchMatch]] formats each match with its `[[section]]` id, POSIX-relative path, line range, and leading paragraph truncated to 300 characters.

## Untrusted identifiers and text are sanitized

[[src/cli/fork-prompt-search.ts#formatCompactSearchMatch]] sanitizes section ids and paths with [[packages/core/src/untrusted.ts#cleanUntrustedId]] and leading paragraphs with [[packages/core/src/untrusted.ts#cleanUntrusted]].

## Hook integration delegates UserPromptSubmit to budgeted search

[[src/cli/hook.ts#searchContextForPrompt]] passes [[src/cli/search.ts#runSearch]] matches into [[src/cli/fork-prompt-search.ts#formatPromptSearchMatches]] for [[src/cli/hook.ts#handleUserPromptSubmit]].
