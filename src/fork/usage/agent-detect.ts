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

export function detectAgent(env: Env = process.env): DetectedAgent {
  if (env.CLAUDECODE === '1')
    return {
      agent: { value: 'claude' },
      sessionId: captured(env.CLAUDE_CODE_SESSION_ID),
    };
  if (env.CODEX_THREAD_ID)
    return {
      agent: { value: 'codex' },
      sessionId: captured(env.CODEX_THREAD_ID),
    };
  if (env.ANTIGRAVITY_CONVERSATION_ID)
    return {
      agent: { value: 'antigravity' },
      sessionId: captured(env.ANTIGRAVITY_CONVERSATION_ID),
    };
  if (env.PI_CODING_AGENT)
    return { agent: { value: 'pi' }, sessionId: unsupported };
  if (env.OPENCODE === '1')
    return { agent: { value: 'opencode' }, sessionId: unsupported };
  return { agent: unsupported, sessionId: unsupported };
}
