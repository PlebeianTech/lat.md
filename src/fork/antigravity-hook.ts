import { existsSync, openSync, readSync, closeSync, statSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { findLatticeDir, findSections, loadAllSections } from '../lattice.js';
import { plainStyler, type CmdContext } from '../context.js';
import { expandPrompt } from '../cli/expand.js';
import { runSearch } from '../cli/search.js';
import { getSection, formatSectionOutput } from '../cli/section.js';
import {
  getStopStatus,
  formatStopReason,
  type StopStatus,
} from '../cli/hook.js';
import { computeCommentBlock } from '../cli/comment-guard.js';
import { taggedDocsForFiles, federateTags } from '../knowledge/index.js';
import {
  loadSessionMarkers,
  saveSessionMarkers,
} from '../knowledge/session.js';

export type AntigravityPreInvocationInput = {
  conversationId?: string;
  workspacePaths?: string[];
  transcriptPath?: string;
  artifactDirectoryPath?: string;
  modelName?: string;
  user_prompt?: string;
  prompt?: string;
  userPrompt?: string;
};

export type AntigravityPreInvocationOutput = {
  injectSteps: Array<{
    ephemeralMessage?: string;
  }>;
};

export type AntigravityPreToolUseInput = {
  toolCall?: {
    name?: string;
    args?: Record<string, unknown>;
  };
  stepIdx?: number;
  workspacePaths?: string[];
};

export type AntigravityPreToolUseOutput = {
  decision: 'allow' | 'deny';
  reason?: string;
};

export type AntigravityStopInput = {
  executionNum?: number;
  execution_num?: number;
  stop_hook_active?: boolean;
  stopHookActive?: boolean;
  terminationReason?: string;
  error?: string;
  fullyIdle?: boolean;
  workspacePaths?: string[];
};

export type AntigravityStopOutput = {
  decision?: 'continue';
  reason?: string;
};

async function readStdin(timeoutMs = 300): Promise<string> {
  if (process.stdin.isTTY) return '';
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let timer: NodeJS.Timeout | null = null;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      try {
        process.stdin.pause();
      } catch {}
      process.stdin.removeListener('data', onData);
      process.stdin.removeListener('end', onEnd);
      process.stdin.removeListener('error', onError);
    };

    const onData = (chunk: Buffer) => {
      chunks.push(chunk);
    };

    const onEnd = () => {
      cleanup();
      resolve(Buffer.concat(chunks).toString('utf-8'));
    };

    const onError = () => {
      cleanup();
      resolve(Buffer.concat(chunks).toString('utf-8'));
    };

    timer = setTimeout(() => {
      cleanup();
      resolve(Buffer.concat(chunks).toString('utf-8'));
    }, timeoutMs);

    process.stdin.on('data', onData);
    process.stdin.on('end', onEnd);
    process.stdin.on('error', onError);
    process.stdin.resume();
  });
}

export function extractLastUserPrompt(transcriptPath?: string): string | null {
  if (!transcriptPath || !existsSync(transcriptPath)) return null;
  let fd: number | null = null;
  try {
    const stat = statSync(transcriptPath);
    if (stat.size === 0) return null;

    fd = openSync(transcriptPath, 'r');
    const chunkSize = Math.min(64 * 1024, stat.size);
    const buffer = Buffer.alloc(chunkSize);
    readSync(fd, buffer, 0, chunkSize, stat.size - chunkSize);
    closeSync(fd);
    fd = null;

    const chunkStr = buffer.toString('utf-8');
    const lines = chunkStr.trim().split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      const entry = JSON.parse(line);
      const isUser =
        entry.type === 'USER_INPUT' ||
        entry.type === 'user' ||
        entry.role === 'user';
      if (isUser) {
        if (typeof entry.content === 'string') return entry.content;
        if (typeof entry.text === 'string') return entry.text;
        if (typeof entry.message === 'string') return entry.message;
        if (Array.isArray(entry.content)) {
          const text = entry.content
            .map((p: unknown) =>
              typeof p === 'string'
                ? p
                : ((p as Record<string, unknown>)?.text ??
                  (p as Record<string, unknown>)?.content ??
                  ''),
            )
            .filter(Boolean)
            .join('\n');
          if (text) return text;
        }
        if (Array.isArray(entry.parts)) {
          const text = entry.parts
            .map((p: unknown) =>
              typeof p === 'string'
                ? p
                : ((p as Record<string, unknown>)?.text ??
                  (p as Record<string, unknown>)?.content ??
                  ''),
            )
            .filter(Boolean)
            .join('\n');
          if (text) return text;
        }
      }
    }
  } catch {
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {}
    }
  }
  return null;
}

function makeHookCtx(latDir: string): CmdContext {
  return {
    latDir,
    projectRoot: dirname(latDir),
    styler: plainStyler,
    mode: 'cli',
  };
}

export async function handleAntigravityPreInvocation(
  rawInput?: string,
  writeOutput = true,
): Promise<AntigravityPreInvocationOutput> {
  const emptyOutput: AntigravityPreInvocationOutput = { injectSteps: [] };
  try {
    const raw = rawInput ?? (await readStdin().catch(() => ''));
    let input: AntigravityPreInvocationInput = {};
    try {
      input = JSON.parse(raw);
    } catch {}

    const userPrompt =
      input.user_prompt ||
      input.prompt ||
      input.userPrompt ||
      extractLastUserPrompt(input.transcriptPath) ||
      '';

    const workspacePaths =
      input.workspacePaths ??
      ((input as Record<string, unknown>).workspace_paths as
        | string[]
        | undefined);

    const latDir = findLatticeDir(workspacePaths?.[0]) ?? findLatticeDir();

    if (!latDir) {
      if (writeOutput) process.stdout.write(JSON.stringify(emptyOutput) + '\n');
      return emptyOutput;
    }

    const ctx = makeHookCtx(latDir);
    const parts: string[] = [];
    const searchFilePaths: string[] = [];

    if (userPrompt) {
      const allSections = await loadAllSections(ctx.latDir).catch(() => []);

      if (/\[\[[^\]]+\]\]/.test(userPrompt)) {
        try {
          const expanded = await expandPrompt(ctx, userPrompt, allSections);
          if (expanded && expanded !== userPrompt) {
            parts.push(expanded, '');
          }
        } catch {}
      }

      try {
        const searchResult = await runSearch(
          ctx.latDir,
          userPrompt,
          5,
          undefined,
          {
            buildIndex: false,
          },
        );
        if (searchResult.matches.length > 0) {
          parts.push(
            `Search results for user prompt (${searchResult.matches.length} matches):`,
            '',
          );
          for (const match of searchResult.matches) {
            searchFilePaths.push(match.section.filePath);
            const sectionResult = await getSection(ctx, match.section.id);
            if (sectionResult.kind === 'found') {
              parts.push(formatSectionOutput(ctx, sectionResult));
              parts.push('');
            }
          }
        }
      } catch {}

      try {
        const filePaths: string[] = [];
        const refTargets = [...userPrompt.matchAll(/\[\[([^\]]+)\]\]/g)].map(
          (m) => m[1],
        );
        for (const target of refTargets) {
          const matches = findSections(allSections, target);
          if (matches.length > 0) {
            filePaths.push(matches[0].section.filePath);
          }
        }
        filePaths.push(...searchFilePaths);

        if (filePaths.length > 0) {
          const docs = await taggedDocsForFiles(ctx.projectRoot, filePaths);
          const sessionId =
            input.conversationId ??
            ((input as Record<string, unknown>).conversation_id as
              | string
              | undefined) ??
            ((input as Record<string, unknown>).session_id as
              | string
              | undefined) ??
            '';
          const sessionMarkers = loadSessionMarkers(sessionId);
          const federated = await federateTags(docs, {
            projectRoot: ctx.projectRoot,
            seen: sessionMarkers.markers.seen,
            attemptedEmpty: sessionMarkers.markers.attemptedEmpty,
          });
          saveSessionMarkers(sessionMarkers);
          if (federated) {
            parts.push('', federated);
          }
        }
      } catch {}
    }

    parts.push(
      'Review whether `lat.md/` needs a current-state update; do not add journal/changelog notes just to satisfy this reminder. Run `lat search` to find relevant sections and `lat check` at the end.',
    );

    const output: AntigravityPreInvocationOutput = {
      injectSteps: [
        {
          ephemeralMessage: parts.join('\n').trim(),
        },
      ],
    };

    if (writeOutput) {
      process.stdout.write(JSON.stringify(output) + '\n');
    }
    return output;
  } catch {
    if (writeOutput) {
      process.stdout.write(JSON.stringify(emptyOutput) + '\n');
    }
    return emptyOutput;
  }
}

export async function handleAntigravityPreToolUse(
  rawInput?: string,
  writeOutput = true,
): Promise<AntigravityPreToolUseOutput> {
  const allow: AntigravityPreToolUseOutput = { decision: 'allow' };
  try {
    const raw = rawInput ?? (await readStdin().catch(() => ''));
    let input: AntigravityPreToolUseInput = {};
    try {
      input = JSON.parse(raw);
    } catch {
      if (writeOutput) process.stdout.write(JSON.stringify(allow) + '\n');
      return allow;
    }

    const rawToolName = input.toolCall?.name ?? '';
    const toolName = rawToolName.split(':').pop() ?? rawToolName;
    const args = input.toolCall?.args ?? {};

    let toolInput: {
      file_path?: string;
      content?: string;
      new_string?: string;
      old_string?: string;
    } = {};

    if (toolName === 'replace_file_content') {
      toolInput = {
        file_path: (args.TargetFile ??
          args.target_file ??
          args.filePath ??
          args.file_path) as string | undefined,
        new_string: (args.ReplacementContent ??
          args.replacement_content ??
          args.new_string) as string | undefined,
        old_string: (args.TargetContent ??
          args.target_content ??
          args.old_string) as string | undefined,
      };
    } else if (toolName === 'write_to_file') {
      toolInput = {
        file_path: (args.TargetFile ??
          args.target_file ??
          args.filePath ??
          args.file_path) as string | undefined,
        content: (args.CodeContent ?? args.code_content ?? args.content) as
          | string
          | undefined,
      };
    } else {
      if (writeOutput) process.stdout.write(JSON.stringify(allow) + '\n');
      return allow;
    }

    const cwd =
      input.workspacePaths?.[0] ??
      (
        (input as Record<string, unknown>).workspace_paths as
          | string[]
          | undefined
      )?.[0] ??
      process.cwd();

    if (!toolInput.file_path) {
      if (writeOutput) process.stdout.write(JSON.stringify(allow) + '\n');
      return allow;
    }

    if (!isAbsolute(toolInput.file_path)) {
      toolInput.file_path = resolve(cwd, toolInput.file_path);
    }

    const reason = computeCommentBlock({
      tool_name: toolName === 'replace_file_content' ? 'Edit' : 'Write',
      tool_input: toolInput,
      cwd,
    });

    if (reason) {
      const deny: AntigravityPreToolUseOutput = {
        decision: 'deny',
        reason,
      };
      if (writeOutput) process.stdout.write(JSON.stringify(deny) + '\n');
      return deny;
    }

    if (writeOutput) process.stdout.write(JSON.stringify(allow) + '\n');
    return allow;
  } catch {
    if (writeOutput) process.stdout.write(JSON.stringify(allow) + '\n');
    return allow;
  }
}

export async function handleAntigravityPostToolUse(
  rawInput?: string,
  writeOutput = true,
): Promise<Record<string, unknown>> {
  const output: Record<string, unknown> = {};
  try {
    const raw = rawInput ?? (await readStdin().catch(() => ''));
    let input: { workspacePaths?: string[] } = {};
    try {
      input = JSON.parse(raw);
    } catch {}

    const workspacePath =
      input.workspacePaths?.[0] ??
      (
        (input as Record<string, unknown>).workspace_paths as
          | string[]
          | undefined
      )?.[0] ??
      ((input as Record<string, unknown>).cwd as string | undefined);
    const latDir = findLatticeDir(workspacePath) ?? findLatticeDir();
    if (latDir) {
      try {
        const { checkIndex } = await import('../cli/check.js');
        await checkIndex(latDir, { fix: true });
      } catch {}
    }
  } catch {}

  if (writeOutput) {
    process.stdout.write(JSON.stringify(output) + '\n');
  }
  return output;
}

export async function handleAntigravityStop(
  rawInput?: string,
  writeOutput = true,
): Promise<AntigravityStopOutput> {
  const allowStop: AntigravityStopOutput = {};
  try {
    const raw = rawInput ?? (await readStdin().catch(() => ''));
    let input: AntigravityStopInput = {};
    try {
      input = JSON.parse(raw);
    } catch {}

    const workspacePath =
      input.workspacePaths?.[0] ??
      (
        (input as Record<string, unknown>).workspace_paths as
          | string[]
          | undefined
      )?.[0] ??
      ((input as Record<string, unknown>).cwd as string | undefined);
    const latDir = findLatticeDir(workspacePath) ?? findLatticeDir();
    if (!latDir) {
      if (writeOutput) process.stdout.write(JSON.stringify(allowStop) + '\n');
      return allowStop;
    }

    const execNum =
      typeof input.executionNum === 'number'
        ? input.executionNum
        : typeof input.execution_num === 'number'
          ? input.execution_num
          : undefined;

    const stopHookActive = Boolean(
      input.stop_hook_active ||
      input.stopHookActive ||
      (execNum !== undefined && execNum > 1),
    );

    let status: StopStatus;
    try {
      status = await getStopStatus(latDir);
    } catch {
      if (writeOutput) process.stdout.write(JSON.stringify(allowStop) + '\n');
      return allowStop;
    }

    const reason = formatStopReason(status);
    if (!reason) {
      if (writeOutput) process.stdout.write(JSON.stringify(allowStop) + '\n');
      return allowStop;
    }

    if (stopHookActive) {
      console.error(
        'Warning: `lat check` still reports errors or sync gaps, but continuing stop to prevent loop.',
      );
      if (writeOutput) process.stdout.write(JSON.stringify(allowStop) + '\n');
      return allowStop;
    }

    const output: AntigravityStopOutput = {
      decision: 'continue',
      reason,
    };
    if (writeOutput) process.stdout.write(JSON.stringify(output) + '\n');
    return output;
  } catch {
    if (writeOutput) process.stdout.write(JSON.stringify(allowStop) + '\n');
    return allowStop;
  }
}

export async function handleAntigravityHook(
  event: string,
  rawInput?: string,
): Promise<void> {
  const normalized = event.toLowerCase();
  switch (normalized) {
    case 'preinvocation':
    case 'userpromptsubmit':
      await handleAntigravityPreInvocation(rawInput);
      return;
    case 'pretooluse':
      await handleAntigravityPreToolUse(rawInput);
      return;
    case 'posttooluse':
      await handleAntigravityPostToolUse(rawInput);
      return;
    case 'stop':
      await handleAntigravityStop(rawInput);
      return;
    default:
      console.error(
        `Unknown hook event for antigravity: ${event}. Supported: PreInvocation, PreToolUse, PostToolUse, Stop`,
      );
      process.exit(1);
  }
}
