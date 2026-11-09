import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  TOOL_ACTIONS,
  USAGE_SCHEMA_VERSION,
  sessionEventId,
  toWorktreeRelativePath,
  type SessionEvent,
  type UsageEvent,
  type TokenUsage,
  type ToolCall,
} from '../src/fork/usage/schema.js';
import { usageEnabled } from '../src/fork/usage/enabled.js';
import { sessionSources } from '../src/fork/usage/sources/index.js';
import { notCapturedSource } from '../src/fork/usage/sources/types.js';

const SPEC_DIR = join(
  import.meta.dirname,
  '..',
  'lat.md',
  'knowledge',
  'tests',
  'usage',
);

describe('session event ids', () => {
  // @lat: [[usage-schema#Usage Schema#Session event ids derive from source path and offset]]
  it('is stable for the same source path and offset', () => {
    expect(sessionEventId('/a/s.jsonl', 10)).toBe(
      sessionEventId('/a/s.jsonl', 10),
    );
  });

  // @lat: [[usage-schema#Usage Schema#Session event ids derive from source path and offset]]
  it('differs when the path or the offset differs', () => {
    const id = sessionEventId('/a/s.jsonl', 10);
    expect(sessionEventId('/a/s.jsonl', 11)).not.toBe(id);
    expect(sessionEventId('/b/s.jsonl', 10)).not.toBe(id);
  });
});

describe('tool calls', () => {
  // @lat: [[usage-schema#Usage Schema#Tool calls carry an action and a target path]]
  it('exports exactly the four actions', () => {
    expect([...TOOL_ACTIONS]).toEqual(['read', 'edit', 'search', 'shell']);
  });

  // @lat: [[usage-schema#Usage Schema#Tool calls carry an action and a target path]]
  it('keeps the action and path of an edit', () => {
    const event: SessionEvent = {
      kind: 'tool_call',
      event_id: sessionEventId('/a/s.jsonl', 0),
      session_id: 's1',
      ts: '2026-11-08T00:00:00Z',
      source: { path: '/a/s.jsonl', offset: 0 },
      tool: { name: 'Edit', action: 'edit', path: 'src/a.ts', bytes: 12 },
    };
    expect(event.kind === 'tool_call' && event.tool.action).toBe('edit');
    expect(event.kind === 'tool_call' && event.tool.path).toBe('src/a.ts');
  });

  // @lat: [[usage-schema#Usage Schema#Tool paths are relative to the worktree]]
  it('normalizes a path inside the worktree to a relative POSIX path', () => {
    expect(toWorktreeRelativePath('/w/tree/src/a.ts', '/w/tree')).toBe(
      'src/a.ts',
    );
  });

  // @lat: [[usage-schema#Usage Schema#Tool paths are relative to the worktree]]
  it('keeps a path outside the worktree absolute', () => {
    expect(toWorktreeRelativePath('/other/a.ts', '/w/tree')).toBe(
      '/other/a.ts',
    );
    expect(toWorktreeRelativePath('/w/tree-two/a.ts', '/w/tree')).toBe(
      '/w/tree-two/a.ts',
    );
  });

  // @lat: [[usage-schema#Usage Schema#Tool paths are relative to the worktree]]
  it('treats a first segment starting with two dots as inside the worktree', () => {
    expect(toWorktreeRelativePath('/w/tree/..cache/a.ts', '/w/tree')).toBe(
      '..cache/a.ts',
    );
    expect(toWorktreeRelativePath('/w/a.ts', '/w/tree')).toBe('/w/a.ts');
  });

  // @lat: [[usage-schema#Usage Schema#Shell calls round-trip command and exit code]]
  it('requires shell data exactly when the action is shell', () => {
    // @ts-expect-error a shell call must carry shell data
    const missing: ToolCall = {
      name: 'Bash',
      action: 'shell',
      path: null,
      bytes: null,
    };
    // @ts-expect-error only a shell call may carry shell data
    const stray: ToolCall = {
      name: 'Read',
      action: 'read',
      path: 'a.ts',
      bytes: 1,
      shell: { command: 'ls', exit_code: { value: 0 } },
    };
    expect([missing, stray]).toHaveLength(2);
  });

  // @lat: [[usage-schema#Usage Schema#Shell calls round-trip command and exit code]]
  it('round-trips a shell command and exit code through JSON', () => {
    const event: SessionEvent = {
      kind: 'tool_call',
      event_id: sessionEventId('/a/s.jsonl', 5),
      session_id: 's1',
      ts: '2026-11-08T00:00:00Z',
      source: { path: '/a/s.jsonl', offset: 5 },
      tool: {
        name: 'Bash',
        action: 'shell',
        path: null,
        bytes: null,
        shell: { command: 'pnpm test', exit_code: { value: 1 } },
      },
    };
    expect(JSON.parse(JSON.stringify(event))).toEqual(event);
  });

  // @lat: [[usage-schema#Usage Schema#Shell calls round-trip command and exit code]]
  it('records a missing exit code as null with a reason, never zero', () => {
    const event: SessionEvent = {
      kind: 'tool_call',
      event_id: sessionEventId('/a/s.jsonl', 6),
      session_id: 's1',
      ts: '2026-11-08T00:00:00Z',
      source: { path: '/a/s.jsonl', offset: 6 },
      tool: {
        name: 'Bash',
        action: 'shell',
        path: null,
        bytes: null,
        shell: {
          command: 'ls',
          exit_code: { value: null, reason: 'not_captured' },
        },
      },
    };
    const parsed = JSON.parse(JSON.stringify(event));
    expect(parsed.tool.shell.exit_code).toEqual({
      value: null,
      reason: 'not_captured',
    });
  });
});

describe('session events', () => {
  // @lat: [[usage-schema#Usage Schema#Subagent events name their parent session]]
  it('keeps parent_session_id on a subagent event through JSON', () => {
    const event: SessionEvent = {
      kind: 'session_start',
      event_id: sessionEventId('/a/sub.jsonl', 0),
      session_id: 'sub1',
      parent_session_id: 's1',
      ts: '2026-11-08T00:00:00Z',
      source: { path: '/a/sub.jsonl', offset: 0 },
    };
    expect(JSON.parse(JSON.stringify(event)).parent_session_id).toBe('s1');
  });
});

describe('token usage', () => {
  // @lat: [[usage-schema#Usage Schema#Token usage keeps the reported cost]]
  it('round-trips reported_cost_usd as reported', () => {
    const event: SessionEvent = {
      kind: 'token_usage',
      event_id: sessionEventId('/a/s.jsonl', 9),
      session_id: 's1',
      ts: '2026-11-08T00:00:00Z',
      source: { path: '/a/s.jsonl', offset: 9 },
      usage: {
        input: 1,
        output: 2,
        cache_read: 3,
        cache_write: 4,
        reasoning: 5,
        reported_cost_usd: 0.0123,
      },
    };
    expect(JSON.parse(JSON.stringify(event))).toEqual(event);
  });
});

describe('token counters', () => {
  // @lat: [[usage-schema#Usage Schema#Unknown token counters carry a reason]]
  it('records an unreported counter as null with a reason, never zero', () => {
    const usage: TokenUsage = {
      input: 10,
      output: 5,
      cache_read: 0,
      cache_write: null,
      reasoning: null,
      unknown_reasons: {
        cache_write: 'unsupported_by_agent',
        reasoning: 'unsupported_by_agent',
      },
    };
    const parsed = JSON.parse(JSON.stringify(usage));
    expect(parsed.cache_write).toBeNull();
    expect(parsed.unknown_reasons.cache_write).toBe('unsupported_by_agent');
  });
});

describe('usage events', () => {
  // @lat: [[usage-schema#Usage Schema#Unknown usage fields carry a reason]]
  it('records an unknown result_count as null with a reason', () => {
    const event: UsageEvent = {
      schema_version: USAGE_SCHEMA_VERSION,
      event_id: 'e1',
      ts: '2026-11-08T00:00:00Z',
      duration_ms: 3,
      command: 'search',
      surface: 'cli',
      caller: 'agent',
      agent: null,
      lat_version: '0.13.4',
      session_id: null,
      parent_session_id: null,
      repo_root: '/r',
      git_head: null,
      worktree: null,
      query: 'x',
      result_ids: [],
      result_count: null,
      section_id: null,
      injected_bytes: null,
      found: null,
      bytes_out: 0,
      exit_code: 0,
      error_class: null,
      unknown_reasons: { result_count: 'not_captured' },
    };
    const parsed = JSON.parse(JSON.stringify(event));
    expect(parsed.result_count).toBeNull();
    expect(parsed.unknown_reasons).toEqual({ result_count: 'not_captured' });
  });
});

describe('usageEnabled', () => {
  const dirs: string[] = [];
  const saved = process.env.LAT_USAGE;

  function makeRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), 'lat-usage-enabled-'));
    dirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of dirs.splice(0))
      rmSync(dir, { recursive: true, force: true });
    if (saved === undefined) delete process.env.LAT_USAGE;
    else process.env.LAT_USAGE = saved;
  });

  // @lat: [[usage-schema#Usage Schema#Usage is opt-in]]
  it('is true when .lat/usage/ exists', () => {
    delete process.env.LAT_USAGE;
    const root = makeRoot();
    mkdirSync(join(root, '.lat', 'usage'), { recursive: true });
    expect(usageEnabled(root)).toBe(true);
  });

  // @lat: [[usage-schema#Usage Schema#Usage is opt-in]]
  it('is true when LAT_USAGE=1', () => {
    process.env.LAT_USAGE = '1';
    expect(usageEnabled(makeRoot())).toBe(true);
  });

  // @lat: [[usage-schema#Usage Schema#Usage is opt-in]]
  it('is false with neither', () => {
    delete process.env.LAT_USAGE;
    expect(usageEnabled(makeRoot())).toBe(false);
  });
});

describe('reader registry', () => {
  // @lat: [[usage-schema#Usage Schema#Reader stubs report nothing captured]]
  it('registers all five readers', () => {
    expect(sessionSources.map((s) => s.agent).sort()).toEqual([
      'antigravity',
      'claude',
      'codex',
      'opencode',
      'pi',
    ]);
  });

  // @lat: [[usage-schema#Usage Schema#Reader stubs report nothing captured]]
  it('returns no events and not_captured from a stub source', async () => {
    const source = notCapturedSource('claude');
    expect(await source.discover('/nonexistent')).toEqual([]);
    const result = await source.read('/nonexistent/s.jsonl', { offset: 7 });
    expect(result.events).toEqual([]);
    expect(result.checkpoint).toEqual({ offset: 7 });
    expect(result.reason).toBe('not_captured');
  });
});

describe('stub specs', () => {
  const STUBS = [
    'usage-tap',
    'usage-mcp-tap',
    'usage-source-claude',
    'usage-source-codex',
    'usage-source-pi',
    'usage-source-opencode',
    'usage-source-antigravity',
    'usage-bd-attribution',
    'usage-aggregate',
    'usage-cli',
    'usage-live',
    'usage-live-raw-events',
    'usage-findings',
    'usage-findings-stale-sections',
    'usage-mcp-tool',
    'usage-gaps-cli',
    'usage-savings',
    'usage-graph-snapshot',
    'usage-missed-knowledge',
    'usage-findings-utilization',
    'usage-section-scorecard',
    'usage-miss-consequences',
    'usage-output-parsers',
  ];

  // @lat: [[usage-schema#Usage Schema#Every usage issue has a spec file]]
  it.each(STUBS)('%s.md exists', (name) => {
    expect(existsSync(join(SPEC_DIR, `${name}.md`))).toBe(true);
  });
});
