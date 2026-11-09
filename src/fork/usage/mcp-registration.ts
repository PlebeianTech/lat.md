import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { findProjectRoot } from '@plebeiantech/lat.md-core/project-discovery';
import { installMcpTap } from './mcp-tap.js';
import { registerUsageTool } from './mcp-usage-tool.js';

/** Fork additions to the MCP server. Call before the first server.tool. */
export function registerForkMcp(server: McpServer): void {
  installMcpTap(server, () => findProjectRoot());
  registerUsageTool(server, () => findProjectRoot());
}
