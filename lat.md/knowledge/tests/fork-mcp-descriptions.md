---
lat:
  require-code-mention: true
---

# Fork Mcp Descriptions

Tests in [[tests/fork-mcp-descriptions.test.ts]] for [[src/mcp/fork-tool-descriptions.ts]], which supplies workflow-ordered tool descriptions with zero em dashes for [[src/mcp/server.ts#startMcpServer]].

## All eight MCP tools have defined descriptions

[[src/mcp/fork-tool-descriptions.ts#FORK_MCP_TOOL_DESCRIPTIONS]] defines a non-empty description string ending with a period and at most 200 characters for all eight MCP tools.

## Tool descriptions contain zero em dashes and en dashes

Every description in [[src/mcp/fork-tool-descriptions.ts#FORK_MCP_TOOL_DESCRIPTIONS]] contains zero Unicode em dashes and zero en dashes.

## Search description contains workflow start cue

`lat_search` in [[src/mcp/fork-tool-descriptions.ts#FORK_MCP_TOOL_DESCRIPTIONS]] instructs agents to start with search for natural-language queries without loading whole files.

## Locate description contains slug lookup cue

`lat_locate` in [[src/mcp/fork-tool-descriptions.ts#FORK_MCP_TOOL_DESCRIPTIONS]] instructs agents to start with locate when part of a section heading or slug is known without reading files.

## Section description directs calling after discovery

`lat_section` in [[src/mcp/fork-tool-descriptions.ts#FORK_MCP_TOOL_DESCRIPTIONS]] directs agents to call `lat_section` after `lat_search` or `lat_locate` rather than reading raw markdown files.

## Refs description directs calling before refactoring

`lat_refs` in [[src/mcp/fork-tool-descriptions.ts#FORK_MCP_TOOL_DESCRIPTIONS]] instructs agents to inspect incoming wiki links and `@lat:` code references before changing code or renaming a section.

## Check description directs validation after editing

`lat_check` in [[src/mcp/fork-tool-descriptions.ts#FORK_MCP_TOOL_DESCRIPTIONS]] instructs agents to validate links, `@lat:` code coverage, indexes, and Diataxis modes after editing.

## Expand description guides prompt reference expansion

`lat_expand` in [[src/mcp/fork-tool-descriptions.ts#FORK_MCP_TOOL_DESCRIPTIONS]] directs agents to resolve inline `[[refs]]` into canonical section paths and context blocks.

## External tool descriptions specify offline inspection

`lat_external_list` and `lat_external_show` in [[src/mcp/fork-tool-descriptions.ts#FORK_MCP_TOOL_DESCRIPTIONS]] state that pinned external sources are inspected without fetching over the network.

## Server registers all tools with workflow ordered descriptions

Spawning `lat mcp` ([[src/mcp/server.ts#startMcpServer]]) over stdio registers all eight tools with descriptions matching [[src/mcp/fork-tool-descriptions.ts#FORK_MCP_TOOL_DESCRIPTIONS]].

## Tool schemas and argument requirements remain unchanged

[[src/mcp/server.ts#startMcpServer]] preserves the parameter schemas, required fields, and defaults across all eight registered MCP tools.
