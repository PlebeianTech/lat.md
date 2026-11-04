import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { dirname } from 'node:path';
import { findLatticeDir } from '@plebeiantech/lat.md-core/project-discovery';
import {
  plainStyler,
  type CmdContext,
  type CmdResult,
} from '@plebeiantech/lat.md-core/context';
import { locateCommand } from '@plebeiantech/lat.md-core/cli/locate';
import { sectionCommand } from '@plebeiantech/lat.md-core/cli/section';
import { searchCommand } from '../cli/search.js';
import {
  DEFAULT_SEARCH_LIMIT,
  DEFAULT_MIN_SIMILARITY,
} from '../search/search.js';
import { expandCommand } from '@plebeiantech/lat.md-core/cli/expand';
import { checkAllCommand } from '@plebeiantech/lat.md-core/cli/check';
import { refsCommand, type Scope } from '@plebeiantech/lat.md-core/cli/refs';
import {
  externalListCommand,
  externalShowCommand,
} from '@plebeiantech/lat.md-core/cli/external';
import { FORK_MCP_TOOL_DESCRIPTIONS } from './fork-tool-descriptions.js';

function toMcp(result: CmdResult) {
  const content = [{ type: 'text' as const, text: result.output }];
  return result.isError ? { content, isError: true } : { content };
}

export async function startMcpServer(): Promise<void> {
  const latDir = findLatticeDir();
  if (!latDir) {
    process.stderr.write('No lat.md directory found\n');
    process.exit(1);
  }
  const projectRoot = dirname(latDir);
  const ctx: CmdContext = {
    latDir,
    projectRoot,
    styler: plainStyler,
    mode: 'mcp',
  };
  const requestContext = (): CmdContext => ({ ...ctx, analysis: undefined });

  const server = new McpServer({
    name: 'lat',
    version: '1.0.0',
  });

  server.tool(
    'lat_locate',
    FORK_MCP_TOOL_DESCRIPTIONS.lat_locate,
    { query: z.string().describe('Section name or id to search for') },
    async ({ query }) => toMcp(await locateCommand(requestContext(), query)),
  );

  server.tool(
    'lat_section',
    FORK_MCP_TOOL_DESCRIPTIONS.lat_section,
    {
      query: z
        .string()
        .describe('Local section id or exact handle:path#fragment target'),
    },
    async ({ query }) => toMcp(await sectionCommand(requestContext(), query)),
  );

  server.tool(
    'lat_search',
    FORK_MCP_TOOL_DESCRIPTIONS.lat_search,
    {
      query: z.string().describe('Search query in natural language'),
      limit: z
        .number()
        .optional()
        .default(DEFAULT_SEARCH_LIMIT)
        .describe(`Max results (default ${DEFAULT_SEARCH_LIMIT})`),
      minSimilarity: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .default(DEFAULT_MIN_SIMILARITY)
        .describe('Minimum cosine similarity score (default 0.20)'),
    },
    async ({ query, limit, minSimilarity }) =>
      toMcp(
        await searchCommand(requestContext(), query, { limit, minSimilarity }),
      ),
  );

  server.tool(
    'lat_expand',
    FORK_MCP_TOOL_DESCRIPTIONS.lat_expand,
    { text: z.string().describe('Text containing [[refs]] to expand') },
    async ({ text: input }) =>
      toMcp(await expandCommand(requestContext(), input)),
  );

  server.tool('lat_check', FORK_MCP_TOOL_DESCRIPTIONS.lat_check, {}, async () =>
    toMcp(await checkAllCommand(requestContext())),
  );

  server.tool(
    'lat_refs',
    FORK_MCP_TOOL_DESCRIPTIONS.lat_refs,
    {
      query: z.string().describe('Section id to find references for'),
      scope: z
        .enum(['md', 'code', 'md+code'])
        .optional()
        .default('md+code')
        .describe('Where to search: md, code, or md+code'),
    },
    async ({ query, scope }) =>
      toMcp(await refsCommand(requestContext(), query, scope as Scope)),
  );

  server.tool(
    'lat_external_list',
    FORK_MCP_TOOL_DESCRIPTIONS.lat_external_list,
    {},
    async () => toMcp(await externalListCommand(ctx, true)),
  );

  server.tool(
    'lat_external_show',
    FORK_MCP_TOOL_DESCRIPTIONS.lat_external_show,
    {
      source: z.string().describe('External source handle or exact target'),
    },
    async ({ source }) => toMcp(await externalShowCommand(ctx, source, true)),
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
