import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { rmDirBestEffort } from './util.js';
import { registerForkMcp } from '../src/fork/usage/mcp-registration.js';
import { installMcpTap } from '../src/fork/usage/mcp-tap.js';
import type { UsageEvent } from '../src/fork/usage/schema.js';

const AGENT_VARIABLES = [
  'CLAUDECODE',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CODEX_THREAD_ID',
  'ANTIGRAVITY_CONVERSATION_ID',
  'PI_CODING_AGENT',
  'OPENCODE',
  'LAT_USAGE',
];

const SEARCH_RESULT = [
  'Search results for "tap":',
  '',
  '* Section: [[cli#CLI#search]]',
  '  > preview mentioning [[cli#CLI#other]]',
  '* File: [[notes]]',
  '* Section: [[dev-process#Dev Process#Testing]]',
  '',
].join('\n');

const SECTION_RESULT = [
  '[[cli#CLI#search]] (lat.md/cli.md:10-20)',
  '',
  '> Body mentioning [[cli#CLI#other]].',
  '',
].join('\n');

const EXPAND_RESULT = [
  'Look at [[cli#CLI#search]] here.',
  '',
  '<lat-context>',
  '* `[[cli#CLI#search]]` is referring to:',
  '  * [[cli#CLI#search]] — Search sections',
  '  * [[cli#CLI#locate]] — Locate sections',
  '</lat-context>',
  '',
].join('\n');

const roots: string[] = [];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const name of AGENT_VARIABLES) {
    savedEnv[name] = process.env[name];
    delete process.env[name];
  }
});

afterEach(() => {
  for (const name of AGENT_VARIABLES) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
  vi.restoreAllMocks();
  roots.splice(0).forEach(rmDirBestEffort);
});

function makeRoot(usageOn = true): string {
  const root = mkdtempSync(join(tmpdir(), 'lat-usage-mcp-'));
  roots.push(root);
  mkdirSync(join(root, 'lat.md'));
  if (usageOn) mkdirSync(join(root, '.lat', 'usage'), { recursive: true });
  return root;
}

function readEvents(root: string): UsageEvent[] {
  const dir = join(root, '.lat', 'usage');
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return [];
  }
  return files.flatMap((f) =>
    readFileSync(join(dir, f), 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as UsageEvent),
  );
}

function text(output: string, isError = false) {
  const content = [{ type: 'text' as const, text: output }];
  return isError ? { content, isError: true } : { content };
}

type Install = (server: McpServer) => void;

/** Registers stand-in tools, with the tap installed first, as server.ts does. */
async function connect(install: Install, tools: Record<string, string> = {}) {
  const server = new McpServer({ name: 'lat', version: '1.0.0' });
  install(server);
  const outputs: Record<string, string> = {
    lat_search: SEARCH_RESULT,
    lat_section: SECTION_RESULT,
    lat_expand: EXPAND_RESULT,
    ...tools,
  };
  server.tool('lat_search', 'search', { query: z.string() }, async () =>
    text(outputs.lat_search),
  );
  server.tool('lat_section', 'section', { query: z.string() }, async () =>
    text(outputs.lat_section, outputs.lat_section.startsWith('No section')),
  );
  server.tool('lat_expand', 'expand', { text: z.string() }, async () =>
    text(outputs.lat_expand),
  );
  server.tool('lat_check', 'check', {}, async () => text('All clear.\n'));
  server.tool('lat_boom', 'boom', {}, async () => {
    throw new Error('boom');
  });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return client;
}

function tapInto(root: string): Install {
  return (server) => installMcpTap(server, () => root);
}

// @lat: [[usage-mcp-tap#Usage MCP Tap#Registration taps every tool]]
describe('registerForkMcp', () => {
  it('writes one mcp event per call with the fields the CLI tap fills', async () => {
    const root = makeRoot();
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    process.env.CLAUDECODE = '1';
    process.env.CLAUDE_CODE_SESSION_ID = 'sess-1';
    const client = await connect(registerForkMcp);

    await client.callTool({ name: 'lat_search', arguments: { query: 'tap' } });
    await client.callTool({ name: 'lat_check', arguments: {} });

    const events = readEvents(root);
    expect(events).toHaveLength(2);
    const [search, check] = events;
    expect(search).toMatchObject({
      schema_version: 1,
      surface: 'mcp',
      command: 'search',
      caller: 'agent',
      agent: 'claude',
      session_id: 'sess-1',
      repo_root: root,
      query: 'tap',
      exit_code: 0,
      error_class: null,
    });
    expect(search.event_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Date(search.ts).toISOString()).toBe(search.ts);
    expect(search.duration_ms).toBeGreaterThanOrEqual(0);
    expect(search.lat_version).not.toBe('');
    expect(search.parent_session_id).toBeNull();
    expect(search.unknown_reasons.parent_session_id).toBe('not_captured');
    expect(check).toMatchObject({
      command: 'check',
      query: null,
      result_ids: [],
      result_count: null,
      bytes_out: Buffer.byteLength('All clear.\n'),
    });
    expect(check.unknown_reasons.result_count).toBe('not_captured');
    expect(check.unknown_reasons.bytes_out).toBeUndefined();
  });

  it('records a human caller when no agent is detected', async () => {
    const root = makeRoot();
    const client = await connect(tapInto(root));
    await client.callTool({ name: 'lat_check', arguments: {} });
    const [event] = readEvents(root);
    expect(event.caller).toBe('human');
    expect(event.agent).toBeNull();
    expect(event.unknown_reasons.agent).toBe('unsupported_by_agent');
  });
});

// @lat: [[usage-mcp-tap#Usage MCP Tap#Search records ids in rank order]]
describe('lat_search', () => {
  it('records result ids in printed order and counts them', async () => {
    const root = makeRoot();
    const client = await connect(tapInto(root));
    await client.callTool({ name: 'lat_search', arguments: { query: 'tap' } });
    const [event] = readEvents(root);
    expect(event.result_ids).toEqual([
      'cli#CLI#search',
      'notes',
      'dev-process#Dev Process#Testing',
    ]);
    expect(event.result_count).toBe(3);
    expect(event.section_id).toBeNull();
    expect(event.unknown_reasons.result_count).toBeUndefined();
  });
});

// @lat: [[usage-mcp-tap#Usage MCP Tap#Section records the section id]]
describe('lat_section', () => {
  it('records the first-line id and found true', async () => {
    const root = makeRoot();
    const client = await connect(tapInto(root));
    await client.callTool({
      name: 'lat_section',
      arguments: { query: 'cli#CLI#search' },
    });
    const [event] = readEvents(root);
    expect(event).toMatchObject({
      command: 'section',
      query: 'cli#CLI#search',
      section_id: 'cli#CLI#search',
      found: true,
    });
    expect(event.unknown_reasons.section_id).toBeUndefined();
    expect(event.unknown_reasons.found).toBeUndefined();
  });

  // @lat: [[usage-mcp-tap#Usage MCP Tap#Missing section records found false]]
  it('records found false when no section is returned', async () => {
    const root = makeRoot();
    const client = await connect(tapInto(root), {
      lat_section: 'No section "nope" found.\n',
    });
    await client.callTool({
      name: 'lat_section',
      arguments: { query: 'nope' },
    });
    const [event] = readEvents(root);
    expect(event).toMatchObject({
      section_id: null,
      found: false,
      exit_code: 1,
      error_class: 'nonzero_exit',
    });
    expect(event.unknown_reasons.found).toBeUndefined();
    expect(event.unknown_reasons.section_id).toBeUndefined();
  });
});

// @lat: [[usage-mcp-tap#Usage MCP Tap#Expand records resolved ids only]]
describe('lat_expand', () => {
  it('records the resolved ids and no section id', async () => {
    const root = makeRoot();
    const client = await connect(tapInto(root));
    await client.callTool({
      name: 'lat_expand',
      arguments: { text: 'Look at [[cli#CLI#search]] here.' },
    });
    const [event] = readEvents(root);
    expect(event.command).toBe('expand');
    expect(event.result_ids).toEqual(['cli#CLI#search']);
    expect(event.result_count).toBe(1);
    expect(event.section_id).toBeNull();
    expect(event.query).toBeNull();
  });
});

// @lat: [[usage-mcp-tap#Usage MCP Tap#Bytes out is the result length]]
describe('bytes_out', () => {
  it('equals the byte length of the result text, not its character count', async () => {
    const root = makeRoot();
    const output = '* Section: [[café#Café#Ünï]]\n';
    const client = await connect(tapInto(root), { lat_search: output });
    await client.callTool({ name: 'lat_search', arguments: { query: 'x' } });
    const [event] = readEvents(root);
    expect(event.bytes_out).toBe(Buffer.byteLength(output));
    expect(event.bytes_out).toBeGreaterThan(output.length);
  });
});

// @lat: [[usage-mcp-tap#Usage MCP Tap#Results pass through unchanged]]
describe('pass-through', () => {
  it('returns the same result with usage on as with usage off', async () => {
    const on = await connect(tapInto(makeRoot(true)));
    const off = await connect(tapInto(makeRoot(false)));
    const bare = await connect(() => undefined);
    for (const [name, args] of [
      ['lat_search', { query: 'tap' }],
      ['lat_section', { query: 'cli#CLI#search' }],
      ['lat_expand', { text: 'x' }],
      ['lat_check', {}],
    ] as const) {
      const expected = await bare.callTool({ name, arguments: args });
      expect(await on.callTool({ name, arguments: args })).toEqual(expected);
      expect(await off.callTool({ name, arguments: args })).toEqual(expected);
    }
  });

  it('rethrows the error a throwing tool raised and records exit code 1', async () => {
    const root = makeRoot();
    const bare = await connect(() => undefined);
    const tapped = await connect(tapInto(root));
    const expected = await bare.callTool({ name: 'lat_boom', arguments: {} });
    expect(await tapped.callTool({ name: 'lat_boom', arguments: {} })).toEqual(
      expected,
    );
    const [event] = readEvents(root);
    expect(event).toMatchObject({
      command: 'boom',
      exit_code: 1,
      error_class: 'nonzero_exit',
      bytes_out: null,
    });
    expect(event.unknown_reasons.bytes_out).toBe('not_captured');
  });
});

// @lat: [[usage-mcp-tap#Usage MCP Tap#The tap never fails a call]]
describe('failure isolation', () => {
  it('writes nothing when usage is off', async () => {
    const root = makeRoot(false);
    const client = await connect(tapInto(root));
    await client.callTool({ name: 'lat_check', arguments: {} });
    expect(readEvents(root)).toEqual([]);
  });

  it('writes nothing, and the call succeeds, when no project is found', async () => {
    const client = await connect((server) => installMcpTap(server, () => null));
    const result = await client.callTool({ name: 'lat_check', arguments: {} });
    expect(result).toEqual(text('All clear.\n'));
  });

  it('leaves the call alone when the root lookup throws', async () => {
    const client = await connect((server) =>
      installMcpTap(server, () => {
        throw new Error('no root');
      }),
    );
    const result = await client.callTool({ name: 'lat_check', arguments: {} });
    expect(result).toEqual(text('All clear.\n'));
  });

  it('leaves the call alone when the events directory cannot be written', async () => {
    const root = makeRoot();
    // A file where the directory should be makes every append fail.
    rmDirBestEffort(join(root, '.lat'));
    mkdirSync(join(root, '.lat'));
    process.env.LAT_USAGE = '1';
    const blocker = join(root, '.lat', 'usage');
    writeFileSync(blocker, 'not a directory');
    const client = await connect(tapInto(root));
    const result = await client.callTool({
      name: 'lat_search',
      arguments: { query: 'tap' },
    });
    expect(result).toEqual(text(SEARCH_RESULT));
  });

  it('keeps the event when a result has no text content', async () => {
    const root = makeRoot();
    const server = new McpServer({ name: 'lat', version: '1.0.0' });
    installMcpTap(server, () => root);
    server.tool('lat_check', 'check', {}, async () => ({ content: [] }));
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '1.0.0' });
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    await client.callTool({ name: 'lat_check', arguments: {} });
    expect(readEvents(root)[0].bytes_out).toBe(0);
  });
});

// @lat: [[usage-mcp-tap#Usage MCP Tap#Events hold no output text]]
describe('stored line', () => {
  it('holds ids, counts and byte lengths but none of the returned text', async () => {
    const root = makeRoot();
    const client = await connect(tapInto(root), {
      lat_section: SECTION_RESULT + 'SECRET-BODY-TEXT\n',
    });
    await client.callTool({ name: 'lat_search', arguments: { query: 'tap' } });
    await client.callTool({
      name: 'lat_section',
      arguments: { query: 'cli#CLI#search' },
    });
    const dir = join(root, '.lat', 'usage');
    const raw = readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => readFileSync(join(dir, f), 'utf-8'))
      .join('');
    expect(raw).not.toContain('SECRET-BODY-TEXT');
    expect(raw).not.toContain('preview mentioning');
    expect(raw).not.toContain('Body mentioning');
  });
});
