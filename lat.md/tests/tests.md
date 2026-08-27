# Tests

High-level test descriptions. Actual test code lives in `tests/`.

## Conventions

Shared patterns for writing and organizing tests in this project.

**Functional over unit.** Prefer functional tests that exercise real `lat` commands against fixture directories over isolated unit tests. Unit tests are only for low-level edge cases that are hard to cover through fixtures (e.g. inline `parseSections` edge cases in `tests/lattice.test.ts`).

**Fixture-based.** Validation scenarios are static directories under `tests/cases/`, each a self-contained mini-project. Mutating commands such as `lat init` use isolated temp directories and invoke the built CLI in child processes.

**Error cases use `error-` prefix.** Test fixture directories that assert error behavior are named with an `error-` prefix (e.g. `error-broken-links`, `error-stale-index`). Success/happy-path fixtures use plain descriptive names (e.g. `valid-links`, `short-ref`).

<!-- lat:index:begin -->
- [Check Code Refs](check-code-refs.md) — Tests for validating \`@lat:\` code references and required code mention coverage.
- [Check Explicit Directories](check-headless.md) — Functional tests cover validation of Markdown directories outside \`lat.md/\`.
- [Check Index](check-index.md) — Tests for validating \`lat.md/\` directory index files and subdirectory index files.
- [Check Coverage](check-coverage.md) — Tests for the floor that fails a \`lat.md/\` tree whose documents no \`@lat:\` code ref anywhere in the project reaches.
- [Check Links](check-links.md) — Tests for full CLI validation of ordinary markdown links to local files in \`lat.md/\` files.
- [Check MD](check-md.md) — Tests for validating wiki links in \`lat.md/\` markdown files.
- [Check Sections](check-sections.md) — Validates that every section in \`lat.md/\` has a well-formed leading paragraph.
- [Comment Guard](comment-guard.md) — Functional tests for the blocking half of the comment convention: the \`PreToolUse\` gate that refuses an \`Edit\`/\`Write\`/\`MultiEdit\` writing a multi-line rationale comment, and tells the agent to move the prose into \`lat.md/\` behind a \`@lat:\` pointer.
- [Comment Reminder](comment-reminder.md) — Functional tests for the write-side \`@lat:\` comment reminder: the \`PostToolUse\` hook heuristic that nudges an agent to add a code ref when it writes a rationale-bearing comment, and the per-agent dispatch that reaches it.
- [Configuration](config.md) — Tests in \`tests/config.test.ts\` verify durable user-level configuration behavior in an isolated XDG directory.
- [Diátaxis Mode Check](mode.md) — Tests for \`checkMode\`'s exemption of imperative sentences that appear inside code samples rather than ordinary prose, for \`lat check mode\` \(see \[\[cli#check\]\]\).
- [Expand](expand.md) — Tests for the \`lat expand\` command that resolves \`\[\[refs\]\]\` and appends context blocks.
- [Fork Instructions](fork-instructions.md) — Tests for the fork's own instruction channel into a consumer project: the \`%% lat-fork:begin %%\` marker block appended to generated agent files, and the \`lat-md-conventions\` skill written beside upstream's.
- [Fork Scaffold](fork-scaffold.md) — Tests for the Diátaxis directory scaffold \`lat init\` writes into a fresh \`lat.md/\`, and the \`require-mode\` gate it turns on in the root index.
- [Frontmatter Field Placement](frontmatter-placement.md) — Tests for \`parseFrontmatter\`'s validation of known \`lat\` fields written at the document root instead of nested under \`lat:\`, and the \`checkFrontmatter\` check that surfaces it via \`lat check\`.
- [Graph Export](graph-export.md) — Functional and unit tests for \[\[cli#graph\]\] — exporting the knowledge graph and diffing it against git history.
- [Hook](hook.md) — Functional tests for Claude, Codex, and Cursor lifecycle hooks. Runs hook commands against fixtures and injects a fake \`git\` through PATH to control \`git diff HEAD --numstat\` output.
- [Init](init.md) — Tests run non-interactive database flows through the built CLI in child processes; TTY-only menu branches use isolated mocks.
- [Knowledge Session Markers](knowledge-session.md) — Tests for the per-session marker store \(\[\[src/knowledge/session.ts\]\]\) that backs federation dedupe across separate hook processes in the same agent session, and the end-to-end federation flow that depends on it.
- [Knowledge Store Additional Coverage](knowledge-store.md) — Additional coverage for the \`Store\` implementations under \[\[src/knowledge/index.ts\]\] added after their original tests were written: per-store concurrency \(lat-t1y.22\), locale/encoding edge cases, and federation hardening against hostile tag/id content.
- [Locate](locate.md) — Tests for \`findSections\` covering exact, subsection, and fuzzy matching strategies.
- [MCP](mcp.md) — Functional tests for the MCP server. Spawns \`lat mcp\` against the \`basic-project\` fixture via the MCP client SDK and verifies each tool responds correctly.
- [Ref Extraction](ref-extraction.md) — Tests for extracting wiki link references from parsed markdown files.
- [Ref Resolution](ref-resolution.md) — Tests for wiki link and code ref resolution across vault subdirectories — ambiguous short refs, unique short refs, and fully qualified refs.
- [Refs End-to-End](refs-e2e.md) — End-to-end tests for the \`lat refs\` command across multiple files.
- [Roundtrip](roundtrip.md) — Parse → render fidelity test for the \[\[parser\]\]. The fixture \`tests/roundtrip.md\` exercises every supported markdown and wiki link feature. The test reads it, runs \`parse\(\)\` → \`toMarkdown\(\)\`, and asserts the output is identical to the input.
- [Search](search.md) — Tests in \`tests/search.test.ts\`.
- [Section](section.md) — Tests for the \`getSection\` core function and \`formatSectionOutput\` formatter.
- [Section Parsing](section-parsing.md) — Tests for parsing markdown into hierarchical section trees with correct metadata.
- [Section Preview Formatting](section-preview.md) — Tests for formatting section previews for terminal output via \[\[cli#Section Preview\]\].
- [Status](status.md) — Functional and unit tests for the \`status\`/\`reviewed-hash\` provenance fields, \`lat check status\`, and the provenance note surfaced above a quoted section.
- [TS Fallback](ts-fallback.md) — Tests that verify the pure-TypeScript code-ref scanner produces identical results to the ripgrep path.
- [Untrusted Text Additional Coverage](untrusted.md) — Additional coverage for \[\[src/untrusted.ts\]\] beyond its original core tests: wider invisible-Unicode stripping and the \`cleanUntrustedId\` helper for values embedded into ids and headings rather than quoted prose.
<!-- lat:index:end -->
