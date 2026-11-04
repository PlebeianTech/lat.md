---
lat:
  require-code-mention: true
---

# Fork Grounding Eval

Evaluation suite in [[tests/fork-grounding-eval.test.ts]] measuring prompt search byte reduction, file coverage preflight precision and recall, diff impact section recall, and MCP/backlink workflow signals across the fork grounding modules.

## Multi-match baseline exceeds budget

Unbudgeted [[packages/core/src/cli/section.ts#formatSectionOutput]] concatenation exceeds [[src/cli/fork-prompt-search.ts#PROMPT_SEARCH_MAX_BYTES]] across every multi-match evaluation fixture.

## Multi-match fork achieves sixty percent byte reduction

[[src/cli/fork-prompt-search.ts#formatPromptSearchMatches]] reduces total UTF-8 byte length by at least 60% compared to unbudgeted full-section output across all multi-match fixtures.

## Multi-match fork stays within hard byte budget

[[src/cli/fork-prompt-search.ts#formatPromptSearchMatches]] keeps every multi-match fixture at or below [[src/cli/fork-prompt-search.ts#PROMPT_SEARCH_MAX_BYTES]].

## Multi-match fork retains complete identifier and location coordinates

[[src/cli/fork-prompt-search.ts#formatPromptSearchMatches]] preserves the `[[section]]` id and `file:startLine-endLine` coordinate for 100% of included matches.

## Single match within budget emits full section body

When one match fits within [[src/cli/fork-prompt-search.ts#PROMPT_SEARCH_MAX_BYTES]], [[src/cli/fork-prompt-search.ts#formatPromptSearchMatches]] emits the full section body via [[packages/core/src/cli/section.ts#getSection]] and [[packages/core/src/cli/section.ts#formatSectionOutput]].

## Single match exceeding budget falls back to compact preview

When one match exceeds [[src/cli/fork-prompt-search.ts#PROMPT_SEARCH_MAX_BYTES]], [[src/cli/fork-prompt-search.ts#formatPromptSearchMatches]] emits a compact preview with [[src/cli/fork-prompt-search.ts#NAVIGATION_HINT]] under budget.

## Naive preflight check produces false positives on code refs and tooling

A naive check that inspects only [[src/cli/fork-coverage-preflight.ts#isPathWikiGrounded]] and file extensions falsely flags `@lat:`-grounded source files and config files.

## Fork preflight achieves perfect precision on labeled prompt corpus

[[src/cli/fork-coverage-preflight.ts#findUngroundedPromptFiles]] achieves 100% precision with zero false positives across the 16-prompt labeled corpus.

## Fork preflight achieves perfect recall on genuinely ungrounded files

[[src/cli/fork-coverage-preflight.ts#findUngroundedPromptFiles]] achieves 100% recall across all genuinely ungrounded files in the labeled corpus, including `#symbol` and `:line:col` tokens.

## Coverage gap notice directs code ref and symbol link remediation

[[src/cli/fork-coverage-preflight.ts#formatCoverageGapNotice]] instructs agents to link files via `// @lat: [[section]]` or `[[file#symbol]]` rather than creating per-file prose sections, with zero em dashes.

## Naive diff matcher misses deep hunks and misattributes deletions

A naive 15-line matcher without nearest-preceding fallback or `+++ /dev/null` handling misses deep-function hunks and misattributes deleted files.

## Fork diff impact achieves perfect recall across all diff fixture categories

[[src/cli/fork-stop-impact.ts#parseUnifiedZeroDiff]] and [[src/cli/fork-stop-impact.ts#findImpactedSectionsForDiff]] achieve 100% recall across all six diff fixture categories.

## Fork diff impact achieves perfect precision with zero spurious sections

[[src/cli/fork-stop-impact.ts#findImpactedSectionsForDiff]] achieves 100% precision with zero spurious sections across all six diff fixtures, including deleted files.

## MCP tool descriptions enforce sequential workflow guidance

Spawning `lat mcp` ([[src/mcp/server.ts#startMcpServer]]) registers [[src/mcp/fork-tool-descriptions.ts#FORK_MCP_TOOL_DESCRIPTIONS]] with discovery cues on `lat_search`/`lat_locate`, post-discovery cues on `lat_section`, and validation cues on `lat_check`.

## MCP tool descriptions contain zero em dashes and zero en dashes

All eight tool descriptions served by `lat mcp` ([[src/mcp/server.ts#startMcpServer]]) end with a period and contain zero Unicode em dashes and zero en dashes.

## Section output formats exact backlink coordinates with role badges

[[packages/core/src/cli/section.ts#formatSectionOutput]] preserves the full leading paragraph, formats `(file:line)` coordinates via [[packages/core/src/fork/section-edges.ts#formatIncomingRefLocation]], and attaches `[test]`/`[code]` badges via [[packages/core/src/fork/section-edges.ts#classifyCodeRefRole]].

## Knowledge graph export classifies all edge semantic roles

[[src/graph-export.ts#buildGraph]] and [[src/graph-export.ts#formatGraphJson]] classify `section-ref`, `symbol-ref`, `test-spec-ref`, `implements`, and `verifies` edge roles while omitting `role` on `contains` edges.
