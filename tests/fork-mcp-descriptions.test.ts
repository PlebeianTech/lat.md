import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  FORK_MCP_TOOL_DESCRIPTIONS,
  type LatMcpToolName,
} from '../src/mcp/fork-tool-descriptions.js';

const casesDir = join(import.meta.dirname, 'cases');
const cliPath = join(
  import.meta.dirname,
  '..',
  'dist',
  'src',
  'cli',
  'index.js',
);

describe('FORK_MCP_TOOL_DESCRIPTIONS', () => {
  const expectedToolNames: LatMcpToolName[] = [
    'lat_check',
    'lat_expand',
    'lat_external_list',
    'lat_external_show',
    'lat_locate',
    'lat_refs',
    'lat_search',
    'lat_section',
  ];

  // @lat: [[fork-mcp-descriptions#Fork Mcp Descriptions#All eight MCP tools have defined descriptions]]
  it('defines descriptions for all eight MCP tools', () => {
    const definedKeys = Object.keys(FORK_MCP_TOOL_DESCRIPTIONS).sort();
    expect(definedKeys).toEqual(expectedToolNames);
    for (const name of expectedToolNames) {
      const desc = FORK_MCP_TOOL_DESCRIPTIONS[name];
      expect(typeof desc).toBe('string');
      expect(desc.trim().length).toBeGreaterThan(0);
      expect(desc.length).toBeLessThanOrEqual(200);
      expect(desc.endsWith('.')).toBe(true);
    }
  });

  // @lat: [[fork-mcp-descriptions#Fork Mcp Descriptions#Tool descriptions contain zero em dashes and en dashes]]
  it('contains zero em dashes and zero en dashes across all descriptions', () => {
    for (const [toolName, desc] of Object.entries(FORK_MCP_TOOL_DESCRIPTIONS)) {
      expect(
        desc,
        `${toolName} must not contain an em dash`,
      ).not.toContain('\u2014');
      expect(
        desc,
        `${toolName} must not contain an en dash`,
      ).not.toContain('\u2013');
      expect(
        desc,
        `${toolName} must not match em/en dash regex`,
      ).not.toMatch(/[\u2014\u2013]/);
    }
  });

  // @lat: [[fork-mcp-descriptions#Fork Mcp Descriptions#Search description contains workflow start cue]]
  it('directs agents to start with search for natural-language intent queries', () => {
    const searchDesc = FORK_MCP_TOOL_DESCRIPTIONS.lat_search;
    expect(searchDesc).toMatch(/start here/i);
    expect(searchDesc).toMatch(/natural-language/i);
    expect(searchDesc).toMatch(/without loading whole files/i);
  });

  // @lat: [[fork-mcp-descriptions#Fork Mcp Descriptions#Locate description contains slug lookup cue]]
  it('directs agents to start with locate when heading or slug is known', () => {
    const locateDesc = FORK_MCP_TOOL_DESCRIPTIONS.lat_locate;
    expect(locateDesc).toMatch(/start here/i);
    expect(locateDesc).toMatch(/heading or slug/i);
    expect(locateDesc).toMatch(/without reading files/i);
  });

  // @lat: [[fork-mcp-descriptions#Fork Mcp Descriptions#Section description directs calling after discovery]]
  it('directs agents to load sections after search or locate', () => {
    const sectionDesc = FORK_MCP_TOOL_DESCRIPTIONS.lat_section;
    expect(sectionDesc).toMatch(/call after lat_search or lat_locate/i);
    expect(sectionDesc).toMatch(/@lat code reference/i);
    expect(sectionDesc).toMatch(/prefer this over reading raw markdown files/i);
  });

  // @lat: [[fork-mcp-descriptions#Fork Mcp Descriptions#Refs description directs calling before refactoring]]
  it('instructs agents to check references before renaming or refactoring', () => {
    const refsDesc = FORK_MCP_TOOL_DESCRIPTIONS.lat_refs;
    expect(refsDesc).toMatch(/before changing code or renaming/i);
    expect(refsDesc).toMatch(/@lat code reference/i);
  });

  // @lat: [[fork-mcp-descriptions#Fork Mcp Descriptions#Check description directs validation after editing]]
  it('instructs agents to validate graph integrity after editing code or documentation', () => {
    const checkDesc = FORK_MCP_TOOL_DESCRIPTIONS.lat_check;
    expect(checkDesc).toMatch(/run after editing/i);
    expect(checkDesc).toMatch(/validate/i);
    expect(checkDesc).toMatch(/@lat code coverage/i);
  });

  // @lat: [[fork-mcp-descriptions#Fork Mcp Descriptions#Expand description guides prompt reference expansion]]
  it('guides agents to expand bracketed references in prompts or notes', () => {
    const expandDesc = FORK_MCP_TOOL_DESCRIPTIONS.lat_expand;
    expect(expandDesc).toMatch(/resolve inline \[\[refs\]\]/i);
    expect(expandDesc).toMatch(/canonical section paths/i);
  });

  // @lat: [[fork-mcp-descriptions#Fork Mcp Descriptions#External tool descriptions specify offline inspection]]
  it('specifies offline cache inspection without network fetching for external tools', () => {
    const listDesc = FORK_MCP_TOOL_DESCRIPTIONS.lat_external_list;
    expect(listDesc).toMatch(/without fetching/i);

    const showDesc = FORK_MCP_TOOL_DESCRIPTIONS.lat_external_show;
    expect(showDesc).toMatch(/without fetching/i);
  });
});

describe('startMcpServer stdio integration', () => {
  let client: Client;

  beforeAll(async () => {
    const transport = new StdioClientTransport({
      command: 'node',
      args: [cliPath, 'mcp'],
      cwd: join(casesDir, 'basic-project'),
    });
    client = new Client({ name: 'fork-test-client', version: '1.0' });
    await client.connect(transport);
  });

  afterAll(async () => {
    await client.close();
  });

  // @lat: [[fork-mcp-descriptions#Fork Mcp Descriptions#Server registers all tools with workflow ordered descriptions]]
  it('registers all eight tools on McpServer with workflow ordered descriptions', async () => {
    const { tools } = await client.listTools();
    expect(tools.length).toBe(8);

    const toolsByName = new Map(tools.map((t) => [t.name, t]));
    for (const [name, expectedDesc] of Object.entries(
      FORK_MCP_TOOL_DESCRIPTIONS,
    )) {
      const registered = toolsByName.get(name);
      expect(registered, `Tool ${name} must be registered`).toBeDefined();
      expect(registered?.description).toBe(expectedDesc);
      expect(registered?.description).not.toContain('\u2014');
      expect(registered?.description).not.toContain('\u2013');
    }
  });

  // @lat: [[fork-mcp-descriptions#Fork Mcp Descriptions#Tool schemas and argument requirements remain unchanged]]
  it('preserves existing input schemas across all registered tools', async () => {
    const { tools } = await client.listTools();
    const schemaByName = new Map(
      tools.map((t) => [
        t.name,
        t.inputSchema as {
          properties?: Record<string, unknown>;
          required?: string[];
        },
      ]),
    );

    const locateSchema = schemaByName.get('lat_locate');
    expect(locateSchema?.required).toEqual(['query']);
    expect(locateSchema?.properties?.query).toBeDefined();

    const sectionSchema = schemaByName.get('lat_section');
    expect(sectionSchema?.required).toEqual(['query']);
    expect(sectionSchema?.properties?.query).toBeDefined();

    const searchSchema = schemaByName.get('lat_search');
    expect(searchSchema?.required).toEqual(['query']);
    expect(searchSchema?.properties?.query).toBeDefined();
    expect(searchSchema?.properties?.limit).toBeDefined();
    expect(searchSchema?.properties?.minSimilarity).toBeDefined();

    const expandSchema = schemaByName.get('lat_expand');
    expect(expandSchema?.required).toEqual(['text']);
    expect(expandSchema?.properties?.text).toBeDefined();

    const checkSchema = schemaByName.get('lat_check');
    expect(checkSchema?.properties).toEqual({});

    const refsSchema = schemaByName.get('lat_refs');
    expect(refsSchema?.required).toEqual(['query']);
    expect(refsSchema?.properties?.query).toBeDefined();
    expect(refsSchema?.properties?.scope).toBeDefined();

    const extListSchema = schemaByName.get('lat_external_list');
    expect(extListSchema?.properties).toEqual({});

    const extShowSchema = schemaByName.get('lat_external_show');
    expect(extShowSchema?.required).toEqual(['source']);
    expect(extShowSchema?.properties?.source).toBeDefined();
  });
});
