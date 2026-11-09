import { existsSync, readFileSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import type { Command } from 'commander';
import { findProjectRoot } from '@plebeiantech/lat.md-core/project-discovery';
import { detectAgent } from './agent-detect.js';
import { usageEnabled } from './enabled.js';
import { applyParsedOutput, parseCommandOutput } from './output-parsers.js';
import { USAGE_SCHEMA_VERSION, type UsageEvent } from './schema.js';
import { writeUsageEvent } from './writer.js';

const QUERY_COMMANDS = new Set([
  'search',
  'locate',
  'section',
  'refs',
  'expand',
]);

/** Commands that run until killed; wrapping their stdout would never end. */
const UNCAPTURED_COMMANDS = new Set(['ui', 'ui run']);

/** Commands never tapped. MCP taps itself; `usage enable` and `usage disable`
 * move .lat/usage/ themselves, so an exit write would undo a disable. */
const UNTAPPED_COMMANDS = new Set(['mcp', 'usage enable', 'usage disable']);

/** Commands whose output a parser reads; others only get a byte count. */
const PARSED_COMMANDS = new Set(['search', 'section', 'expand', 'hook']);

const DEFAULT_MAX_RETAINED_BYTES = 1024 * 1024;

interface CapturedOutput {
  byteLength: number;
  /** Null when the command is not parsed or its output passed the cap. */
  text: Buffer | null;
}

interface StdoutCapture {
  stop(): CapturedOutput;
}

/**
 * Counts what the command writes to stdout while passing every write through
 * to the real stream with its original arguments and return value. Keeps the
 * chunks only when asked, and only up to maxRetainedBytes.
 */
function captureStdout(
  retain: boolean,
  maxRetainedBytes: number,
): StdoutCapture {
  const chunks: Buffer[] = [];
  let byteLength = 0;
  let retainedBytes = 0;
  let overCap = false;
  const originalWrite = process.stdout.write;
  const capturingWrite = function (this: unknown, ...args: unknown[]) {
    try {
      const [chunk, encoding] = args as [
        string | Uint8Array,
        BufferEncoding | undefined,
      ];
      const copy =
        typeof chunk === 'string'
          ? Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf8')
          : Buffer.from(chunk);
      byteLength += copy.length;
      if (retain && !overCap) {
        retainedBytes += copy.length;
        if (retainedBytes > maxRetainedBytes) {
          overCap = true;
          chunks.length = 0;
        } else chunks.push(copy);
      }
    } catch {
      // A chunk that cannot be copied only costs this event some bytes.
    }
    return (originalWrite as (...a: unknown[]) => boolean).apply(
      process.stdout,
      args,
    );
  };
  process.stdout.write = capturingWrite as typeof process.stdout.write;
  return {
    stop() {
      if (process.stdout.write === capturingWrite)
        process.stdout.write = originalWrite;
      return {
        byteLength,
        text: retain && !overCap ? Buffer.concat(chunks) : null,
      };
    },
  };
}

function commandName(command: Command): string {
  const names: string[] = [];
  for (let c: Command | null = command; c?.parent; c = c.parent)
    names.unshift(c.name());
  return names.join(' ');
}

interface GitState {
  head: string | null;
  worktree: string | null;
}

function readTrimmed(path: string): string | null {
  try {
    return readFileSync(path, 'utf-8').trim();
  } catch {
    return null;
  }
}

function findGitEntry(from: string): string | null {
  for (let dir = from; ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.git'))) return dir;
    if (dirname(dir) === dir) return null;
  }
}

function resolveRef(commonDir: string, gitDir: string, ref: string) {
  const loose =
    readTrimmed(join(gitDir, ref)) ?? readTrimmed(join(commonDir, ref));
  if (loose) return loose;
  const packed = readTrimmed(join(commonDir, 'packed-refs'));
  const line = packed?.split('\n').find((l) => l.endsWith(` ${ref}`));
  return line ? line.split(' ')[0] : null;
}

export function readGitState(root: string): GitState {
  try {
    const worktree = findGitEntry(root);
    if (worktree === null) return { head: null, worktree: null };
    const dotGit = join(worktree, '.git');
    let gitDir = dotGit;
    if (statSync(dotGit).isFile()) {
      const pointer = readTrimmed(dotGit)?.match(/^gitdir:\s*(.+)$/)?.[1];
      if (!pointer) return { head: null, worktree };
      gitDir = resolve(worktree, pointer);
    }
    const commonPointer = readTrimmed(join(gitDir, 'commondir'));
    const commonDir = commonPointer ? resolve(gitDir, commonPointer) : gitDir;
    const head = readTrimmed(join(gitDir, 'HEAD'));
    if (!head) return { head: null, worktree };
    const ref = head.match(/^ref:\s*(.+)$/)?.[1];
    if (ref) return { head: resolveRef(commonDir, gitDir, ref), worktree };
    return { head: /^[0-9a-f]{40,64}$/.test(head) ? head : null, worktree };
  } catch {
    return { head: null, worktree: null };
  }
}

function buildEvent(
  program: Command,
  actionCommand: Command,
  root: string,
  start: number,
  exitCode: number,
  captured: CapturedOutput | null,
): UsageEvent {
  const name = commandName(actionCommand);
  const { agent, sessionId } = detectAgent();
  const { head, worktree } = readGitState(root);
  const isHook = name.split(' ')[0] === 'hook';
  const unknown_reasons: UsageEvent['unknown_reasons'] = {
    parent_session_id: 'not_captured',
    section_id: 'not_captured',
    found: 'not_captured',
    result_count: 'not_captured',
    bytes_out: 'not_captured',
  };
  if (agent.value === null) unknown_reasons.agent = agent.reason;
  if (sessionId.value === null) unknown_reasons.session_id = sessionId.reason;
  if (head === null) unknown_reasons.git_head = 'not_captured';
  if (worktree === null) unknown_reasons.worktree = 'not_captured';
  if (isHook) unknown_reasons.injected_bytes = 'not_captured';
  const event: UsageEvent = {
    schema_version: USAGE_SCHEMA_VERSION,
    event_id: randomUUID(),
    ts: new Date(start).toISOString(),
    duration_ms: Date.now() - start,
    command: name,
    surface: isHook ? 'hook' : 'cli',
    caller: isHook ? 'hook-injected' : agent.value ? 'agent' : 'human',
    agent: agent.value,
    lat_version: program.version() ?? 'unknown',
    session_id: sessionId.value,
    parent_session_id: null,
    repo_root: root,
    git_head: head,
    worktree,
    query: QUERY_COMMANDS.has(name) ? (actionCommand.args[0] ?? null) : null,
    result_ids: [],
    result_count: null,
    section_id: null,
    injected_bytes: null,
    found: null,
    bytes_out: null,
    exit_code: exitCode,
    error_class: exitCode === 0 ? null : 'nonzero_exit',
    unknown_reasons,
  };
  if (captured !== null) addCapturedFields(event, name, captured, exitCode);
  return event;
}

/** Fills the fields that depend on what the command printed; ids and counts only. */
function addCapturedFields(
  event: UsageEvent,
  name: string,
  captured: CapturedOutput,
  exitCode: number,
): void {
  event.bytes_out = captured.byteLength;
  delete event.unknown_reasons.bytes_out;
  if (captured.text === null) return;
  try {
    const parsed = parseCommandOutput(
      name,
      captured.text.toString('utf-8'),
      exitCode,
    );
    applyParsedOutput(event, parsed);
  } catch {
    // The event keeps null with its reason for what the parser could not tell.
  }
}

export function installCliTap(
  program: Command,
  maxRetainedBytes = DEFAULT_MAX_RETAINED_BYTES,
): void {
  program.hook('preAction', (_program, actionCommand) => {
    try {
      const start = Date.now();
      const root = findProjectRoot(program.opts().dir);
      const name = commandName(actionCommand);
      if (root === null || UNTAPPED_COMMANDS.has(name) || !usageEnabled(root))
        return;
      const capture = UNCAPTURED_COMMANDS.has(name)
        ? null
        : captureStdout(
            PARSED_COMMANDS.has(name.split(' ')[0]),
            maxRetainedBytes,
          );
      process.once('exit', (exitCode) => {
        try {
          const captured = capture?.stop() ?? null;
          writeUsageEvent(
            root,
            buildEvent(program, actionCommand, root, start, exitCode, captured),
          );
        } catch {
          return;
        }
      });
    } catch {
      return;
    }
  });
}
