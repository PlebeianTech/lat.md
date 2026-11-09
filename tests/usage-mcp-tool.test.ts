import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/fork/usage/sources/index.js', () => ({ sessionSources: [] }));
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerForkMcp } from '../src/fork/usage/mcp-registration.js';
import {
  USAGE_SCHEMA_VERSION,
  type UsageEvent,
} from '../src/fork/usage/schema.js';
import { writeUsageEvent } from '../src/fork/usage/writer.js';
import { rmDirBestEffort } from './util.js';

const AGENT_VARIABLES = [
  'CLAUDECODE',
  'CLAUDE_CODE_SESSION_ID',
  'CODEX_THREAD_ID',
  'ANTIGRAVITY_CONVERSATION_ID',
  'PI_CODING_AGENT',
  'OPENCODE',
  'LAT_USAGE',
];

const T0 = Date.parse('2026-11-08T10:00:00Z');
const DAY = 24 * 60 * 60_000;
const at = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();

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

let counter = 0;
function usage(fields: Partial<UsageEvent>): UsageEvent {
  counter++;
  return {
    schema_version: USAGE_SCHEMA_VERSION,
    event_id: `u${String(counter).padStart(4, '0')}`,
    ts: at(0),
    duration_ms: 100,
    command: 'search',
    surface: 'cli',
    caller: 'agent',
    agent: 'claude',
    lat_version: '0.0.0',
    session_id: 'A',
    parent_session_id: null,
    repo_root: '/repo',
    git_head: null,
    worktree: null,
    query: null,
    result_ids: [],
    result_count: null,
    section_id: null,
    injected_bytes: null,
    found: null,
    bytes_out: null,
    exit_code: 0,
    error_class: null,
    unknown_reasons: {},
    ...fields,
  };
}

function makeRoot(usageOn = true): string {
  const root = mkdtempSync(join(tmpdir(), 'lat-usage-tool-'));
  roots.push(root);
  mkdirSync(join(root, 'lat.md'));
  execFileSync('git', ['-C', root, 'init', '-q']);
  execFileSync('git', [
    '-C',
    root,
    '-c',
    'user.name=T',
    '-c',
    'user.email=t@example.com',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'init',
  ]);
  if (usageOn) mkdirSync(join(root, '.lat', 'usage'), { recursive: true });
  return root;
}

/** Two agents, two sessions, one empty search each, spread over two days. */
function seed(root: string): void {
  const events = [
    usage({
      session_id: 'A',
      agent: 'claude',
      query: 'tap',
      result_count: 0,
      ts: at(0),
    }),
    usage({
      session_id: 'A',
      agent: 'claude',
      command: 'section',
      ts: at(1000),
    }),
    usage({
      session_id: 'B',
      agent: 'codex',
      query: 'tap',
      result_count: 0,
      ts: at(DAY),
    }),
  ];
  for (const event of events) writeUsageEvent(root, event);
}

async function connect(root: string, register?: (server: McpServer) => void) {
  vi.spyOn(process, 'cwd').mockReturnValue(root);
  const server = new McpServer({ name: 'lat', version: '1.0.0' });
  registerForkMcp(server);
  register?.(server);
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return client;
}

async function call(
  client: Client,
  args: Record<string, unknown> = {},
): Promise<any> {
  const result = (await client.callTool({
    name: 'lat_usage',
    arguments: args,
  })) as { content: { type: string; text: string }[]; isError?: boolean };
  expect(result.isError).toBeFalsy();
  return JSON.parse(result.content[0].text);
}

// @lat: [[usage-mcp-tool#Usage MCP Tool#Registered only with a usage directory]]
describe('registration', () => {
  it('lists lat_usage when the usage directory exists', async () => {
    const client = await connect(makeRoot(true));
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toContain('lat_usage');
  });

  it('omits lat_usage when the directory is missing, even with LAT_USAGE=1', async () => {
    process.env.LAT_USAGE = '1';
    const client = await connect(makeRoot(false), (server) =>
      server.tool('lat_check', 'check', async () => ({ content: [] })),
    );
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).not.toContain('lat_usage');
  });

  it('omits lat_usage when .lat/usage is a symlink', async () => {
    const root = makeRoot(false);
    const target = mkdtempSync(join(tmpdir(), 'lat-usage-tool-target-'));
    roots.push(target);
    mkdirSync(join(root, '.lat'));
    symlinkSync(target, join(root, '.lat', 'usage'));
    const client = await connect(root, (server) =>
      server.tool('lat_check', 'check', async () => ({ content: [] })),
    );
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).not.toContain('lat_usage');
  });
});

// @lat: [[usage-mcp-tool#Usage MCP Tool#Summary view returns filtered totals]]
describe('summary view', () => {
  it('returns valid JSON totals, with unknown as null', async () => {
    const root = makeRoot();
    seed(root);
    const client = await connect(root);
    const out = await call(client);
    expect(out.view).toBe('summary');
    expect(out.schema_version).toBe(USAGE_SCHEMA_VERSION);
    expect(out.totals.commands).toBe(3);
    expect(out.totals.sessions).toBe(2);
    expect(out.totals.zero_result_searches).toBe(2);
    expect(out.totals.bytes_out.total).toBeNull();
    expect(out.totals.bytes_out.unknown).toBe(3);
    expect(out.signals).toBeDefined();
  });

  it('narrows by agent', async () => {
    const root = makeRoot();
    seed(root);
    const out = await call(await connect(root), { agent: 'codex' });
    expect(out.totals.commands).toBe(1);
    expect(out.filters).toEqual({ agent: 'codex' });
  });

  it('narrows by session', async () => {
    const root = makeRoot();
    seed(root);
    const out = await call(await connect(root), { session: 'A' });
    expect(out.totals.commands).toBe(2);
  });

  it('narrows by since', async () => {
    const root = makeRoot();
    seed(root);
    const out = await call(await connect(root), { since: '2026-11-09' });
    expect(out.totals.commands).toBe(1);
    expect(out.filters).toEqual({ from: '2026-11-09' });
  });

  it('narrows by issue, so an unknown issue matches nothing', async () => {
    const root = makeRoot();
    seed(root);
    const out = await call(await connect(root), { issue: 'lat-none' });
    expect(out.totals.commands).toBe(0);
  });

  it('reports an invalid since date as a tool error', async () => {
    const root = makeRoot();
    const client = await connect(root);
    const result = (await client.callTool({
      name: 'lat_usage',
      arguments: { since: 'nonsense' },
    })) as { isError?: boolean; content: { text: string }[] };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid from date');
  });
});

// @lat: [[usage-mcp-tool#Usage MCP Tool#Savings is a range]]
describe('savings', () => {
  it('is a range with method version and label, or unknown with a reason', async () => {
    const root = makeRoot();
    seed(root);
    const out = await call(await connect(root));
    const { savings } = out;
    if (savings.range === null) {
      expect(typeof savings.reason).toBe('string');
    } else {
      expect(savings.range).toEqual({
        low: expect.any(Number),
        point: expect.any(Number),
        high: expect.any(Number),
      });
      expect(savings.method_version).toBeDefined();
      expect(typeof savings.label).toBe('string');
    }
  });
});

// @lat: [[usage-mcp-tool#Usage MCP Tool#Issue rows are not additive]]
describe('issue rows', () => {
  it('carries a not-additive note and no grand total', async () => {
    const root = makeRoot();
    seed(root);
    const out = await call(await connect(root));
    expect(out.issues_note).toMatch(/not additive/);
    expect(Array.isArray(out.issues)).toBe(true);
    expect(out.issues_total).toBe(out.issues.length);
  });
});

// @lat: [[usage-mcp-tool#Usage MCP Tool#Findings view returns ranked findings]]
describe('findings view', () => {
  it('returns ranked findings as JSON', async () => {
    const root = makeRoot();
    seed(root);
    const out = await call(await connect(root), { view: 'findings' });
    expect(out.view).toBe('findings');
    expect(Array.isArray(out.findings)).toBe(true);
    expect(out.findings.length).toBeGreaterThan(0);
    const empty = out.findings.find(
      (finding: { kind: string }) => finding.kind === 'empty-search',
    );
    expect(empty).toMatchObject({ subject: 'tap', sessions: 2, count: 2 });
    expect(out.errors).toEqual([]);
  });

  it('narrows by agent', async () => {
    const root = makeRoot();
    seed(root);
    const out = await call(await connect(root), {
      view: 'findings',
      agent: 'codex',
    });
    const empty = out.findings.find(
      (finding: { kind: string }) => finding.kind === 'empty-search',
    );
    expect(empty).toMatchObject({ sessions: 1, count: 1 });
  });

  it('caps the findings and evidence it returns', async () => {
    const root = makeRoot();
    for (let i = 0; i < 25; i++)
      writeUsageEvent(
        root,
        usage({ query: `q${i}`, result_count: 0, ts: at(i) }),
      );
    const out = await call(await connect(root), { view: 'findings' });
    expect(out.findings.length).toBeLessThanOrEqual(10);
    expect(out.findings_total).toBe(25);
  });
});

// @lat: [[usage-mcp-tool#Usage MCP Tool#Disabled returns an empty result]]
describe('disabled', () => {
  it('returns an empty result with a reason when the directory is gone', async () => {
    const root = makeRoot();
    seed(root);
    const client = await connect(root);
    rmDirBestEffort(join(root, '.lat'));
    for (const view of ['summary', 'findings']) {
      const out = await call(client, { view });
      expect(out).toMatchObject({ view, empty: true });
      expect(out.reason).toMatch(/usage tracking is off/i);
    }
  });
});

// @lat: [[usage-mcp-tool#Usage MCP Tool#Calls are recorded]]
describe('recording', () => {
  it('writes an mcp usage event for a lat_usage call', async () => {
    const root = makeRoot();
    seed(root);
    process.env.CLAUDECODE = '1';
    process.env.CLAUDE_CODE_SESSION_ID = 'sess-tool';
    const client = await connect(root);
    await call(client, { view: 'summary' });
    const dir = join(root, '.lat', 'usage');
    const recorded = readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .flatMap((f) => readFileSync(join(dir, f), 'utf-8').split('\n'))
      .filter(Boolean)
      .map((line) => JSON.parse(line) as UsageEvent)
      .filter((event) => event.surface === 'mcp');
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      surface: 'mcp',
      command: 'usage',
      session_id: 'sess-tool',
    });
  });
});
