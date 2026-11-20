import { realpathSync } from 'node:fs';
import { resolveProjectRoot } from '../cli/comment-reminder.js';
import { buildReadRefAdvice } from './read-ref-advice.js';

/** The fields of Claude Code's PostToolUse payload that a Read hook uses. */
type ClaudeReadInput = {
  session_id?: string;
  tool_input?: { file_path?: string; offset?: number; limit?: number };
};

/**
 * Advice for the `@lat:` references in the lines a Claude Code Read returned,
 * or null. Read omits `offset`, or sends 0, when it reads from the top of the
 * file. The file path is resolved through symlinks because git reports the
 * project root that way.
 */
export function claudeReadRefAdvice(input: ClaudeReadInput): string | null {
  try {
    const toolInput = input.tool_input ?? {};
    if (!toolInput.file_path) return null;
    const filePath = realpathSync(toolInput.file_path);
    const projectRoot = resolveProjectRoot(filePath);
    if (!projectRoot) return null;
    return buildReadRefAdvice({
      projectRoot,
      filePath,
      firstLine: toolInput.offset || 1,
      lineCount: toolInput.limit,
      sessionId: input.session_id,
    });
  } catch {
    return null;
  }
}
