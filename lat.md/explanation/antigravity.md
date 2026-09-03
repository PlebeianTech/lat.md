---
lat:
  mode: explanation
---
# Antigravity and Gemini Support

How this fork supports Google Antigravity and Gemini CLI agents alongside Claude Code, using non-intrusive lifecycle hooks and unified conventions.

Support for Antigravity aligns with the fork's core principles: small diffs against upstream, zero conflict with upstream files, and deterministic knowledge grounding across coding agents.

## Architecture and integration points

Antigravity connects via lifecycle hooks, instruction files, and skills that follow the fork's small-diff design principles.

Integration points include:
- `src/fork/antigravity-hook.ts`: The standalone hook dispatcher translating Antigravity JSON payloads to knowledge graph queries, comment checks, and check gates.
- `src/fork/antigravity-init.ts`: The onboarding helper configuring `.agents/hooks.json`, `GEMINI.md`, skills, and MCP registration.
- `plugins/lat-md/`: A bundled plugin containing the manifest, lifecycle hooks, rules, and skills ready for loading in Antigravity, packaged with npm releases.

## Lifecycle hook mapping

Antigravity lifecycle events map to the same enforcement gates as Claude Code without sharing protocol-specific payloads.

The lifecycle events operate as follows:
- `PreInvocation`: Injects ephemeral context containing expanded wiki link references, semantic search results for user prompts, federated knowledge from tagged documents, and current-state reminders. Tail reads of transcript files avoid memory overhead on long sessions while supporting structured user message blocks.
- `PreToolUse`: Inspects pending edits from `replace_file_content` or `write_to_file`. By stripping namespace prefixes and resolving relative paths against workspace roots, the gate inspects replacement deltas accurately using `new_string` and `old_string` (`TargetContent`). When multi-line rationale comments are detected, the hook denies the edit and advises documenting the rationale in `lat.md/`. All failures fail open.
- `PostToolUse`: Synchronizes indexes and directory structures after file edits complete.
- `Stop`: Evaluates graph health with `lat check` and compares codebase diff volume against documentation changes using `getStopStatus`. When errors or sync gaps are found, the hook returns a `continue` decision with specific reasons. A second-pass loop guard ensures the agent never becomes trapped in infinite loops.

## Instruction and skill distribution

Instruction files and bundled plugin assets ensure Antigravity agents observe the project's knowledge graph conventions.

`lat init` targets `GEMINI.md` with both upstream `%% lat:begin %%` and fork `%% lat-fork:begin %%` blocks. Hook setup parses existing `.agents/hooks.json` files with JSONC resilience to preserve third-party agent hooks. It installs both `lat-md` and `lat-md-conventions` skills into `.agents/skills/` using the canonical `SKILL_FRONTMATTER`. The bundled `plugins/lat-md` directory provides a self-contained plugin package that works seamlessly in environments using Antigravity plugins. See [[install-antigravity-plugin]] for step-by-step installation instructions.
