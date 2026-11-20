# Tests

High-level test descriptions. Actual test code lives in `tests/`.

## Conventions

Shared patterns for writing and organizing tests in this project.

**Functional over unit.** Prefer functional tests that exercise real `lat` commands against fixture directories over isolated unit tests. Unit tests are only for low-level edge cases that are hard to cover through fixtures (e.g. inline `parseSections` edge cases in `tests/lattice.test.ts`).

**Fixture-based.** Validation scenarios are static directories under `tests/cases/`, each a self-contained mini-project. Mutating commands such as `lat init` use isolated temp directories and invoke the built CLI in child processes.

**Error cases use `error-` prefix.** Test fixture directories that assert error behavior are named with an `error-` prefix (e.g. `error-broken-links`, `error-stale-index`). Success/happy-path fixtures use plain descriptive names (e.g. `valid-links`, `short-ref`).

<!-- lat:index:begin -->
- [Check Code Refs](check-code-refs.md) — Tests for validating \`@lat:\` code references and required code mention coverage.
- [Check Coverage](check-coverage.md) — Tests for \[\[packages/core/src/cli/check-coverage.ts#checkCoverage\]\], the floor that fails a \`lat.md/\` tree holding documents that no \`@lat:\` ref anywhere in the codebase reaches.
- [Check Explicit Directories](check-headless.md) — Functional tests cover validation of Markdown directories outside \`lat.md/\`.
- [Check Index](check-index.md) — Tests for validating \`lat.md/\` directory index files and subdirectory index files.
- [Check Links](check-links.md) — Tests for full CLI validation of ordinary markdown links to local files in \`lat.md/\` files.
- [Check MD](check-md.md) — Tests for validating wiki links in \`lat.md/\` markdown files.
- [Check Sections](check-sections.md) — Validates that every section in \`lat.md/\` has a well-formed leading paragraph.
- [Comment Guard](comment-guard.md) — Functional tests for the blocking half of the comment convention: the \`PreToolUse\` gate that refuses an \`Edit\`/\`Write\`/\`MultiEdit\` writing a multi-line rationale comment, and tells the agent to move the prose into \`lat.md/\` behind a \`@lat:\` pointer.
- [Comment Reminder](comment-reminder.md) — Functional tests for the write-side \`@lat:\` comment reminder: the \`PostToolUse\` hook heuristic that nudges an agent to add a code ref when it writes a rationale-bearing comment, and the per-agent dispatch that reaches it.
- [Configuration](config.md) — Tests verify durable user configuration and read-only storage diagnostics in isolated XDG directories.
- [Diátaxis Mode Check](mode.md) — Tests for \`checkMode\`'s exemption of imperative sentences that appear inside code samples rather than ordinary prose, for \`lat check mode\` \(see \[\[cli#check\]\]\).
- [Expand](expand.md) — Tests for the \`lat expand\` command that resolves \`\[\[refs\]\]\` and appends context blocks.
- [External Sources](external-tests.md) — External-source tests verify pinned remote content is resolved reproducibly and safely across every Lat interface.
- [Fork Codebase Memory Store](fork-codebase-memory-store.md) — Tests in \[\[tests/fork-codebase-memory-store.test.ts\]\] for \[\[src/fork/adapters/codebase-memory-store.ts\]\], the external store adapter for codebase-memory-mcp, run against a fake binary on \`PATH\`.
- [Fork Coverage Preflight](fork-coverage-preflight.md): Tests for \[\[src/cli/fork-coverage-preflight.ts\]\], which surfaces ungrounded prompt file paths during UserPromptSubmit preflight execution.
- [Fork Decision Model Rerank](fork-decision-model-rerank.md) — Tests in \[\[tests/fork-decision-model-rerank.test.ts\]\] for \[\[src/fork/decision-model-rerank.ts\]\], which reorders \`lat search\` results with a decision model. \`fetch\` is mocked, so no test reaches the network.
- [Fork External Callers](fork-external-callers.md) — Tests in \[\[tests/knowledge/callers.test.ts\]\] for \[\[src/knowledge/callers.ts\]\], which asks a registered external store who calls a code symbol.
- [Fork External Stores](fork-external-stores.md) — Tests in \[\[tests/knowledge/external.test.ts\]\] for \[\[src/knowledge/external.ts\]\], which runs the knowledge stores registered in the user's lat config.
- [Fork Federate Hit Cap](fork-federate-hit-cap.md) — Tests in \[\[tests/knowledge/federate-hit-cap.test.ts\]\] for the total hit cap that \[\[src/knowledge/index.ts#federateTags\]\] applies to one prompt.
- [Fork Federate Usage](fork-federate-usage.md) — Tests in \[\[tests/knowledge/federate-usage.test.ts\]\] for the usage events that \[\[src/knowledge/index.ts#federateTags\]\] writes per store query, and for how aggregation treats them.
- [Fork Graph Edge Roles](fork-graph-edge-roles.md): Tests for graph export edge classification in \[\[src/graph-export.ts\]\], which assigns optional semantic roles to knowledge graph edges.
- [Fork Grounding Eval](fork-grounding-eval.md): Evaluation suite in \[\[tests/fork-grounding-eval.test.ts\]\] verifying prompt search budget reduction, file coverage preflight precision and recall, diff impact section recall, and MCP backlink workflow signal quality.
- [Fork Guard Nested Repo](fork-guard-nested-repo.md) — Tests in \[\[tests/fork-guard-nested-repo.test.ts\]\] for \[\[hooks/lat-guard.sh\]\], which must not treat a git repository named \`lat.md\` as a docs directory.
- [Fork Instructions](fork-instructions.md) — Tests for \[\[src/cli/fork-instructions.ts\]\], the fork's own instruction channel into a consumer project — the marker block it appends to generated agent files and the conventions skill it writes beside upstream's.
- [Fork Mcp Descriptions](fork-mcp-descriptions.md): Tests for \[\[src/mcp/fork-tool-descriptions.ts\]\], which supplies workflow-ordered tool descriptions in Strunk & White voice with zero em dashes for the MCP server.
- [Fork Multi-QA Search Model](fork-multi-qa-search-model.md) — Tests in \[\[tests/fork-multi-qa-search-model.test.ts\]\] and \[\[tests/fork-multi-qa-search-model-init.test.ts\]\] for \[\[src/fork/multi-qa-search-model.ts\]\], which downloads the default local search model and decides which model each index uses. \`fetch\` is mocked, so no test reaches the network.
- [Fork Prompt Search](fork-prompt-search.md): Tests for \[\[src/cli/fork-prompt-search.ts\]\], which caps search context enrichment in UserPromptSubmit under a hard byte budget with compact section previews.
- [Fork Read Ref Advice](fork-read-ref-advice.md) — Tests in \[\[tests/fork-read-ref-advice.test.ts\]\] for \[\[src/fork/read-ref-advice.ts#buildReadRefAdvice\]\], which turns the \`@lat:\` references in a range of lines an agent read into advice to query lat. The advice names section ids and commands only, never section text.
- [Fork Read Ref Hooks](fork-read-ref-hooks.md) — Tests in \[\[tests/fork-read-ref-claude-hook.test.ts\]\] for \[\[src/fork/read-ref-claude-hook.ts#claudeReadRefAdvice\]\], which advises Claude Code after a Read touches \`@lat:\` references, and for the hook wiring that runs it.
- [Fork Resolve](fork-resolve.md) — Tests in \[\[tests/fork-resolve.test.ts\]\] for \[\[src/cli/fork-resolve.ts\]\], which turns one wiki-link target into a file and line for \[\[cli#resolve\]\]. Each test runs against a temporary project with sections, a source file, a plain file and an external source.
- [Fork Scaffold](fork-scaffold.md) — Tests for \[\[src/cli/fork-scaffold.ts\]\], which gives a freshly created \`lat.md/\` the four Diátaxis directories, and for the \`require-mode\` gate in \[\[packages/core/src/cli/check-mode.ts#checkMode\]\] that the scaffold turns on.
- [Fork Section Edges](fork-section-edges.md): Tests for \[\[packages/core/src/fork/section-edges.ts\]\], which classifies code reference roles and formats citation coordinates for section backlinks.
- [Fork Stop Diff Base](fork-stop-diff-base.md) — Tests in \[\[tests/fork-stop-diff-base.test.ts\]\] for \[\[src/fork/stop-diff-base.ts#stopDiffBase\]\], which picks the revision that \[\[cli#hook#Stop\]\] measures changes from.
- [Fork Stop Impact](fork-stop-impact.md): Tests for \[\[src/cli/fork-stop-impact.ts\]\], which intersects git diff line ranges with \`@lat:\` references and wiki links on Stop hook execution.
- [Fork Stop Reminder Memory](fork-stop-reminder-memory.md) — Tests in \[\[tests/fork-stop-reminder-memory.test.ts\]\] for \[\[src/fork/stop-reminder-memory.ts\]\], which lets \[\[cli#hook#Stop\]\] issue the sync reminder once per set of code changes.
- [Fork Stop Sync Message](fork-stop-sync-message.md) — Tests in \[\[tests/fork-stop-sync-message.test.ts\]\] for \[\[src/fork/stop-sync-message.ts#stopSyncMessage\]\], the sync-only reminder text of \[\[cli#hook#Stop\]\].
- [Fork Vendor UI Server](fork-vendor-ui-server.md) — Tests in \[\[tests/fork-vendor-ui-server.test.ts\]\] for \[\[scripts/fork-vendor-ui-server.ts\]\], run against a small fixture tree so \`lat ui build server\` keeps working from the vendored copy.
- [Fork VS Code Wiki Links](fork-vscode-wiki-links.md) — Tests in \[\[packages/vscode-wiki-links/src/find-wiki-links.test.ts\]\] and \[\[packages/vscode-wiki-links/src/resolve-with-lat.test.ts\]\] for \[\[packages/vscode-wiki-links/src/find-wiki-links.ts\]\], which finds the wiki links the VS Code extension makes clickable, and \[\[packages/vscode-wiki-links/src/resolve-with-lat.ts\]\], which resolves a link target with \`lat resolve\`.
- [Frontmatter Field Placement](frontmatter-placement.md) — Tests for \`parseFrontmatter\`'s validation of known \`lat\` fields written at the document root instead of nested under \`lat:\`, and the \`checkFrontmatter\` check that surfaces it via \`lat check\`.
- [Gen GitHub Wiki Workflow Tests](gen-github-wiki-workflow.md) — Functional tests for wiki workflow template rendering and placeholder substitution.
- [Graph Export](graph-export.md) — Functional and unit tests for \[\[cli#graph\]\] — exporting the knowledge graph and diffing it against git history.
- [Hook](hook.md) — Functional tests for Claude, Codex, and Cursor lifecycle hooks. Hook subprocesses use fake Git output; \[\[src/cli/hook.ts#analyzeDiff\]\] also runs against temporary real repositories.
- [Init](init.md) — Tests run non-interactive database flows through the built CLI in child processes; TTY-only menu branches use isolated mocks.
- [Knowledge Session Markers](knowledge-session.md) — Tests for the per-session marker store \(\[\[src/knowledge/session.ts\]\]\) that backs federation dedupe across separate hook processes in the same agent session, and the end-to-end federation flow that depends on it.
- [Knowledge Store Additional Coverage](knowledge-store.md) — Additional coverage for the \`Store\` implementations under \[\[src/knowledge/index.ts\]\] added after their original tests were written: per-store concurrency \(lat-t1y.22\), locale/encoding edge cases, and federation hardening against hostile tag/id content.
- [Locate](locate.md) — Tests for \`findSections\` covering exact, subsection, and fuzzy matching strategies.
- [MCP](mcp.md) — Functional tests for the MCP server. Spawns \`lat mcp\` against the \`basic-project\` fixture via the MCP client SDK and verifies each tool responds correctly.
- [Mermaid Readability Tests](check-diagrams.md) — These tests verify deterministic flowchart complexity limits and horizontal readability estimates using Mermaid's parser and imported Dagre layout without a browser.
- [Package Distribution](distribution-tests.md) — Distribution tests exercise packed installations and the npm-installing check action outside the development workspace, ensuring dependencies and assets are sufficient without workspace fallbacks.
- [Parser Analysis Tests](analysis-tests.md) — These tests keep Markdown and source analysis deterministic, AST-free, serializable, and safely reusable across parser executions.
- [PHP Source Parser](php-source-parser.md) — PHP source analysis and code-reference scanning cover Laravel application and test files without treating Blade attributes as code references.
- [Ref Extraction](ref-extraction.md) — Tests for extracting wiki link references from parsed markdown files.
- [Ref Resolution](ref-resolution.md) — Tests for wiki link and code ref resolution across vault subdirectories — ambiguous short refs, unique short refs, and fully qualified refs.
- [Refs End-to-End](refs-e2e.md) — End-to-end tests for the \`lat refs\` command across multiple files.
- [Roundtrip](roundtrip.md) — Parse → render fidelity test for the \[\[parser\]\]. The fixture \`tests/roundtrip.md\` exercises every supported markdown and wiki link feature. The test reads it, runs \`parse\(\)\` → \`toMarkdown\(\)\`, and asserts the output is identical to the input.
- [Search](search.md) — Tests in \`tests/search.test.ts\`.
- [Section](section.md) — Tests for the \`getSection\` core function and \`formatSectionOutput\` formatter.
- [Section Parsing](section-parsing.md) — Tests for parsing markdown into hierarchical section trees with correct metadata.
- [Section Preview Formatting](section-preview.md) — Tests for formatting section previews for terminal output via \[\[cli#Section Preview\]\].
- [Status](status.md) — Functional and unit tests for the \`status\`/\`reviewed-hash\` provenance fields, \`lat check status\`, and the provenance note surfaced above a quoted section.
- [Swift Source Links](swift-source-parser.md) — Swift source links resolve declarations and type members through the shared source parser, validation, and code-reference scanner.
- [TS Fallback](ts-fallback.md) — Tests that verify the pure-TypeScript code-ref scanner produces identical results to the ripgrep path.
- [Untrusted Text Additional Coverage](untrusted.md) — Additional coverage for \[\[packages/core/src/untrusted.ts\]\] beyond its original core tests: wider invisible-Unicode stripping and the \`cleanUntrustedId\` helper for values embedded into ids and headings rather than quoted prose.
- [Wiki Tests](wiki.md) — Functional and unit specifications for GitHub Wiki export and publication.
- [Impact](impact.md) — Functional tests for \`lat impact\`: depth listing, \`--specs\`, \`--unreferenced\` and the output budget, run against this repository's own graph.
- [Usage](usage/usage.md) — Specifications for the usage analytics epic: event schema, taps, session readers, aggregation, dashboard and findings.
<!-- lat:index:end -->
