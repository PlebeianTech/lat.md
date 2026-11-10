import type { Captured } from './schema.js';

export interface DetectedAgent {
  agent: Captured<string>;
  sessionId: Captured<string>;
}

type Env = Record<string, string | undefined>;

const unsupported = { value: null, reason: 'unsupported_by_agent' } as const;

function captured(value: string | undefined): Captured<string> {
  return value ? { value } : unsupported;
}

function detected(agent: string, sessionId: Captured<string>): DetectedAgent {
  return { agent: { value: agent }, sessionId };
}

export function detectAgent(env: Env = process.env): DetectedAgent {
  // Claude Code sets CLAUDE_CODE_CHILD_SESSION=1 on every process it spawns,
  // main session included, so it does not mark a subagent. A subagent's
  // commands carry the parent's CLAUDE_CODE_SESSION_ID and land there.
  if (env.CLAUDECODE === '1')
    return detected('claude', captured(env.CLAUDE_CODE_SESSION_ID));
  if (env.CODEX_THREAD_ID)
    return detected('codex', captured(env.CODEX_THREAD_ID));
  if (env.ANTIGRAVITY_CONVERSATION_ID)
    return detected('antigravity', captured(env.ANTIGRAVITY_CONVERSATION_ID));
  if (env.PI_CODING_AGENT) return detected('pi', unsupported);
  if (env.OPENCODE === '1') return detected('opencode', unsupported);
  return { agent: unsupported, sessionId: unsupported };
}
