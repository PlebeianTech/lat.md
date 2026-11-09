import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { rmDirBestEffort } from './util.js';
import { registerForkCli } from '../src/fork/usage/cli-registration.js';
import { installCliTap } from '../src/fork/usage/cli-tap.js';
import {
  parseExpandOutput,
  parseHookOutput,
  parseSearchOutput,
  parseSectionOutput,
  stripAnsi,
} from '../src/fork/usage/output-parsers.js';
import type { UsageEvent } from '../src/fork/usage/schema.js';

const parserControl = vi.hoisted(() => ({ throwing: false }));
vi.mock('../src/fork/usage/output-parsers.js', async (importActual) => {
  const actual =
    await importActual<typeof import('../src/fork/usage/output-parsers.js')>();
  return {
    ...actual,
    parseCommandOutput: (
      ...args: Parameters<typeof actual.parseCommandOutput>
    ) => {
      if (parserControl.throwing) throw new Error('parser failed');
      return actual.parseCommandOutput(...args);
    },
  };
});

const roots: string[] = [];
afterEach(() => {
  parserControl.throwing = false;
  roots.splice(0).forEach(rmDirBestEffort);
});

const ESC = '\u001b';
const SEARCH_OUTPUT = [
  '* Section: [[cli#CLI#search]] (score: 0.9)',
  '  Defined in lat.md/cli.md:10-20',
  '',
  '  > Mentions [[cli#CLI#section]] and [[other#Other]] in its preview.',
  '',
  '* File: [[notes]]',
  '  Defined in lat.md/notes.md:1-5',
  '',
  '* Section: [[dev-process#Dev Process#Testing]]',
  '  Defined in lat.md/dev-process.md:3-9',
  '',
].join('\n');

// @lat: [[usage-output-parsers#Usage Output Parsers#Search ids keep rank order]]
describe('parseSearchOutput', () => {
  it('returns ids in printed order and ignores refs inside previews', () => {
    expect(parseSearchOutput(SEARCH_OUTPUT)).toEqual([
      'cli#CLI#search',
      'notes',
      'dev-process#Dev Process#Testing',
    ]);
  });

  it('returns no ids for output without result lines', () => {
    expect(parseSearchOutput('No results found.\n')).toEqual([]);
  });
});

// @lat: [[usage-output-parsers#Usage Output Parsers#ANSI codes are stripped]]
describe('stripAnsi', () => {
  it('removes colour codes so styled output parses like plain output', () => {
    const styled = `${ESC}[2m*${ESC}[22m ${ESC}[2mSection:${ESC}[22m [[${ESC}[2mcli#CLI#${ESC}[22m${ESC}[1;37msearch${ESC}[39m]]\n`;
    expect(stripAnsi(styled)).toBe('* Section: [[cli#CLI#search]]\n');
    expect(parseSearchOutput(styled)).toEqual(['cli#CLI#search']);
  });
});

// @lat: [[usage-output-parsers#Usage Output Parsers#Section id comes from the first line]]
describe('parseSectionOutput', () => {
  const body = [
    '[[cli#CLI#search]] (lat.md/cli.md:10-20)',
    '',
    '> Body mentioning [[cli#CLI#other]].',
    '',
    '## This section references:',
    '',
    '* [[cli#CLI#section]] — summary',
    '',
    '## Referenced by:',
    '',
    '* [[cli#CLI#hook]] — summary',
    '',
  ].join('\n');

  it('takes the id on the first line only', () => {
    expect(parseSectionOutput(body, 0)).toEqual({
      sectionId: 'cli#CLI#search',
      found: true,
    });
  });

  it('strips the bold the styler puts around the first line', () => {
    const styled = `${ESC}[1m[[${ESC}[2mcli#CLI#${ESC}[22msearch]]${ESC}[22m (lat.md/cli.md:1-2)\n`;
    expect(parseSectionOutput(styled, 0).sectionId).toBe('cli#CLI#search');
  });

  it('reports found false when a failing command printed no section', () => {
    expect(parseSectionOutput('', 1)).toEqual({
      sectionId: null,
      found: false,
    });
  });

  it('reports nothing when a successful command printed no section id', () => {
    expect(parseSectionOutput('something else\n', 0)).toEqual({
      sectionId: null,
      found: null,
    });
  });
});

// @lat: [[usage-output-parsers#Usage Output Parsers#Expand records the best match per ref]]
describe('parseExpandOutput', () => {
  const expanded = [
    'See [[cli#CLI#search]] and [[hook]] today.',
    '',
    '<lat-context>',
    'Notice: untrusted.',
    '* `[[cli#CLI#search]]` is referring to:',
    '  * [[cli#CLI#search]]',
    '    * lat.md/cli.md:10-20',
    '    * "Quote with [[ghost#Ghost]] inside"',
    '* `[[hook]]` might be referring to either of the following:',
    '  * [[cli#CLI#hook]] (substring match)',
    '    * lat.md/cli.md:30-40',
    '  * [[fork#Fork#hook]] (fuzzy match)',
    '    * lat.md/fork.md:1-9',
    '</lat-context>',
    '',
  ].join('\n');

  it('returns the best match of each ref in order', () => {
    expect(parseExpandOutput(expanded)).toEqual([
      'cli#CLI#search',
      'cli#CLI#hook',
    ]);
  });
});

// @lat: [[usage-output-parsers#Usage Output Parsers#Hook ids come from the search results list]]
describe('parseHookOutput', () => {
  const envelope = (additionalContext: string) =>
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext,
      },
    });
  const listed = [
    'Before starting work, run `lat search`. See [[ignored#Ignored]].',
    '',
    'Search results for the user prompt (2 matches):',
    '',
    '* [[cli#CLI#search]] (lat.md/cli.md:10-20) - Mentions [[x#X]].',
    '* [[cli#CLI#hook]] (lat.md/cli.md:30-40)',
    '',
    'Run lat section "section#id" to read the full content of a matching section.',
    '',
    'Sections linked to modified code: [[stop#Stop]]',
  ].join('\n');

  it('takes bullet ids under the search results heading only', () => {
    const parsed = parseHookOutput(envelope(listed));
    expect(parsed.resultIds).toEqual(['cli#CLI#search', 'cli#CLI#hook']);
    expect(parsed.sectionId).toBeNull();
    expect(parsed.injectedBytes).toBe(Buffer.byteLength(listed, 'utf-8'));
  });

  it('records the section when one match printed its full body', () => {
    const full = [
      'Reminder.',
      '',
      'Search results for the user prompt (1 matches):',
      '',
      '[[cli#CLI#search]] (lat.md/cli.md:10-20)',
      '',
      '> Body with [[body#Ref]].',
      '',
      '* [[refs#Refs]] — a reference',
    ].join('\n');
    const parsed = parseHookOutput(envelope(full));
    expect(parsed.resultIds).toEqual(['cli#CLI#search']);
    expect(parsed.sectionId).toBe('cli#CLI#search');
  });

  it('excludes the Stop hook list and counts injected bytes in UTF-8', () => {
    const stop = 'Review é.\n\nSections linked to modified code: [[stop#Stop]]';
    const parsed = parseHookOutput(envelope(stop));
    expect(parsed.resultIds).toBeNull();
    expect(parsed.injectedBytes).toBe(Buffer.byteLength(stop, 'utf-8'));
  });

  it('reports unknown for output that is not a hook envelope', () => {
    expect(parseHookOutput('{"decision":"block","reason":"x"}')).toEqual({
      resultIds: null,
      sectionId: null,
      injectedBytes: null,
    });
    expect(parseHookOutput('not json')).toEqual({
      resultIds: null,
      sectionId: null,
      injectedBytes: null,
    });
  });

  it('counts a hook that printed nothing as zero injected bytes', () => {
    expect(parseHookOutput('').injectedBytes).toBe(0);
  });
});

function makeProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'lat-usage-parsers-'));
  roots.push(root);
  cpSync(join(import.meta.dirname, 'cases', 'basic-project'), root, {
    recursive: true,
  });
  return root;
}

function eventLines(root: string): string[] {
  const dir = join(root, '.lat', 'usage');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.jsonl'))
    .flatMap((name) =>
      readFileSync(join(dir, name), 'utf-8').split('\n').filter(Boolean),
    );
}

type WriteCall = unknown[];

interface ProbeOptions {
  exitCode?: number;
  /** Retention cap handed to installCliTap; registerForkCli when absent. */
  maxRetainedBytes?: number;
  /** What the stream's write returns; true when absent. */
  writeReturns?: boolean;
}

/**
 * Runs a probe command through the tap with a recording stream in place of
 * process.stdout.write, then fires the exit listener the tap registered.
 * Each printed entry is a string, or the full argument list of one write.
 */
async function runProbe(
  commandPath: string[],
  printed: Array<string | unknown[]>,
  options: ProbeOptions = {},
): Promise<{
  calls: WriteCall[];
  returns: unknown[];
  lines: string[];
  recorder: unknown;
  writeSeenByCommand: unknown;
}> {
  const root = makeProject();
  const listeners: Array<(code: number) => void> = [];
  const once = vi.spyOn(process, 'once').mockImplementation(((
    event: string,
    listener: (code: number) => void,
  ) => {
    if (event === 'exit') listeners.push(listener);
    return process;
  }) as never);
  const originalWrite = process.stdout.write;
  const calls: WriteCall[] = [];
  const returns: unknown[] = [];
  let writeSeenByCommand: unknown;
  const recorder = ((...args: unknown[]) => {
    calls.push(args);
    return options.writeReturns ?? true;
  }) as never;
  process.stdout.write = recorder;
  vi.stubEnv('LAT_USAGE', '1');
  try {
    const program = new Command().name('lat').option('--dir <path>');
    if (options.maxRetainedBytes === undefined) registerForkCli(program);
    else installCliTap(program, options.maxRetainedBytes);
    let parent = program;
    for (const name of commandPath.slice(0, -1)) parent = parent.command(name);
    parent.command(commandPath[commandPath.length - 1]).action(() => {
      writeSeenByCommand = process.stdout.write;
      for (const entry of printed)
        returns.push(
          (process.stdout.write as (...a: unknown[]) => unknown)(
            ...(Array.isArray(entry) ? entry : [entry]),
          ),
        );
    });
    await program.parseAsync(['--dir', root, ...commandPath], { from: 'user' });
    listeners.forEach((listener) => listener(options.exitCode ?? 0));
  } finally {
    process.stdout.write = originalWrite;
    once.mockRestore();
    vi.unstubAllEnvs();
  }
  return {
    calls,
    returns,
    lines: eventLines(root),
    recorder,
    writeSeenByCommand,
  };
}

describe('stdout capture in the tap', () => {
  // @lat: [[usage-output-parsers#Usage Output Parsers#Counts and bytes come from the capture]]
  it('sets bytes_out to the captured byte length and result_count to the id count', async () => {
    const { lines } = await runProbe(['search'], [SEARCH_OUTPUT]);
    const event = JSON.parse(lines[0]) as UsageEvent;
    expect(event.bytes_out).toBe(Buffer.byteLength(SEARCH_OUTPUT, 'utf-8'));
    expect(event.result_ids).toEqual([
      'cli#CLI#search',
      'notes',
      'dev-process#Dev Process#Testing',
    ]);
    expect(event.result_count).toBe(3);
    expect(event.unknown_reasons.bytes_out).toBeUndefined();
    expect(event.unknown_reasons.result_count).toBeUndefined();
  });

  it('sums chunks, counting multibyte text in bytes', async () => {
    const { lines } = await runProbe(['check'], ['é', 'ab\n']);
    const event = JSON.parse(lines[0]) as UsageEvent;
    expect(event.bytes_out).toBe(5);
    expect(event.result_count).toBeNull();
    expect(event.unknown_reasons.result_count).toBe('not_captured');
  });

  it('records the section and found true for a section command', async () => {
    const { lines } = await runProbe(
      ['section'],
      ['[[cli#CLI#search]] (lat.md/cli.md:1-2)\n\n> body [[a#b]]\n'],
    );
    const event = JSON.parse(lines[0]) as UsageEvent;
    expect(event.section_id).toBe('cli#CLI#search');
    expect(event.found).toBe(true);
    expect(event.unknown_reasons.section_id).toBeUndefined();
    expect(event.unknown_reasons.found).toBeUndefined();
  });

  it('records found false for a failing section command with no output', async () => {
    const { lines } = await runProbe(['section'], [], { exitCode: 1 });
    const event = JSON.parse(lines[0]) as UsageEvent;
    expect(event.found).toBe(false);
    expect(event.section_id).toBeNull();
    expect(event.bytes_out).toBe(0);
  });

  it('records expand ids as result_ids and no section_id', async () => {
    const out =
      '<lat-context>\n* `[[a]]` is referring to:\n  * [[a#A]]\n</lat-context>\n';
    const { lines } = await runProbe(['expand'], [out]);
    const event = JSON.parse(lines[0]) as UsageEvent;
    expect(event.result_ids).toEqual(['a#A']);
    expect(event.result_count).toBe(1);
    expect(event.section_id).toBeNull();
  });

  it('records hook injected_bytes and result_ids with caller hook-injected', async () => {
    const context =
      'Search results for the user prompt (1 matches):\n\n* [[cli#CLI#hook]] (lat.md/cli.md:1-2)\n';
    const envelope = JSON.stringify({
      hookSpecificOutput: { additionalContext: context },
    });
    const { lines } = await runProbe(['hook'], [envelope]);
    const event = JSON.parse(lines[0]) as UsageEvent;
    expect(event.caller).toBe('hook-injected');
    expect(event.result_ids).toEqual(['cli#CLI#hook']);
    expect(event.result_count).toBe(1);
    expect(event.injected_bytes).toBe(Buffer.byteLength(context, 'utf-8'));
    expect(event.bytes_out).toBe(Buffer.byteLength(envelope, 'utf-8'));
  });

  // @lat: [[usage-output-parsers#Usage Output Parsers#Output passes through unchanged]]
  it('passes every write through with the same arguments and return value', async () => {
    const { calls, returns } = await runProbe(
      ['search'],
      ['first chunk\n', SEARCH_OUTPUT],
    );
    expect(calls).toEqual([['first chunk\n'], [SEARCH_OUTPUT]]);
    expect(returns).toEqual([true, true]);
  });

  it('stores no output text in the event line', async () => {
    const secret = 'SECRET-PREVIEW-TEXT';
    const { lines } = await runProbe(
      ['search'],
      [`* Section: [[a#A]]\n  > ${secret}\n`],
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain(secret);
    expect(lines[0]).not.toContain('Defined in');
  });

  // @lat: [[usage-output-parsers#Usage Output Parsers#A throwing parser leaves the event]]
  it('still writes the event when the parser throws', async () => {
    parserControl.throwing = true;
    const { lines, calls } = await runProbe(['search'], [SEARCH_OUTPUT]);
    expect(calls).toEqual([[SEARCH_OUTPUT]]);
    const event = JSON.parse(lines[0]) as UsageEvent;
    expect(event.bytes_out).toBe(Buffer.byteLength(SEARCH_OUTPUT, 'utf-8'));
    expect(event.result_ids).toEqual([]);
    expect(event.result_count).toBeNull();
    expect(event.unknown_reasons.result_count).toBe('not_captured');
  });

  // @lat: [[usage-output-parsers#Usage Output Parsers#Long-running commands are not captured]]
  it.each([['ui'], ['ui', 'run']])(
    'leaves stdout untouched and records no bytes_out for lat %s',
    async (...commandPath) => {
      const { writeSeenByCommand, recorder, lines } = await runProbe(
        commandPath,
        ['served\n'],
      );
      expect(writeSeenByCommand).toBe(recorder);
      const event = JSON.parse(lines[0]) as UsageEvent;
      expect(event.bytes_out).toBeNull();
      expect(event.unknown_reasons.bytes_out).toBe('not_captured');
    },
  );

  it('captures lat ui build server, which ends', async () => {
    const { writeSeenByCommand, recorder, lines } = await runProbe(
      ['ui', 'build', 'server'],
      ['built\n'],
    );
    expect(writeSeenByCommand).not.toBe(recorder);
    expect((JSON.parse(lines[0]) as UsageEvent).bytes_out).toBe(6);
  });

  it('leaves stdout untouched and writes no event for lat mcp', async () => {
    const { writeSeenByCommand, recorder, lines } = await runProbe(
      ['mcp'],
      ['rpc\n'],
    );
    expect(writeSeenByCommand).toBe(recorder);
    expect(lines).toEqual([]);
  });

  // @lat: [[usage-output-parsers#Usage Output Parsers#Retained output is capped]]
  it('keeps bytes_out exact and nulls parsed fields past the retention cap', async () => {
    const { lines } = await runProbe(['search'], [SEARCH_OUTPUT], {
      maxRetainedBytes: 10,
    });
    const event = JSON.parse(lines[0]) as UsageEvent;
    expect(event.bytes_out).toBe(Buffer.byteLength(SEARCH_OUTPUT, 'utf-8'));
    expect(event.result_ids).toEqual([]);
    expect(event.result_count).toBeNull();
    expect(event.unknown_reasons.result_count).toBe('not_captured');
  });

  it('parses output at exactly the cap and counts commands without a parser', async () => {
    const size = Buffer.byteLength(SEARCH_OUTPUT, 'utf-8');
    const parsed = await runProbe(['search'], [SEARCH_OUTPUT], {
      maxRetainedBytes: size,
    });
    expect((JSON.parse(parsed.lines[0]) as UsageEvent).result_count).toBe(3);
    const counted = await runProbe(['check'], [SEARCH_OUTPUT], {
      maxRetainedBytes: 1,
    });
    expect((JSON.parse(counted.lines[0]) as UsageEvent).bytes_out).toBe(size);
  });

  it('passes encoding and callback through and returns the stream backpressure value', async () => {
    const callback = () => {};
    const { calls, returns } = await runProbe(
      ['search'],
      [['caf\u00e9\n', 'latin1', callback]],
      { writeReturns: false },
    );
    expect(calls).toEqual([['caf\u00e9\n', 'latin1', callback]]);
    expect(calls[0][2]).toBe(callback);
    expect(returns).toEqual([false]);
  });
});
