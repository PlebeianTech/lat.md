import type { SessionEvent, UnknownReason } from '../schema.js';

export const SESSION_AGENTS = [
  'claude',
  'codex',
  'pi',
  'opencode',
  'antigravity',
] as const;
export type SessionAgent = (typeof SESSION_AGENTS)[number];

/** Where a reader stopped; passing it back resumes after the last event. */
export interface Checkpoint {
  offset: number;
}

export interface ReadResult {
  events: SessionEvent[];
  checkpoint: Checkpoint;
  /** Set when the reader cannot supply data; null when it read normally. */
  reason: UnknownReason | null;
}

/** Reader contract. Neither method may throw. */
export interface SessionSource {
  agent: SessionAgent;
  /** Session transcript paths for a repo root, including its worktrees. */
  discover(repoRoot: string): Promise<string[]>;
  read(sessionPath: string, checkpoint: Checkpoint | null): Promise<ReadResult>;
}

export function notCapturedSource(agent: SessionAgent): SessionSource {
  return {
    agent,
    discover: async () => [],
    read: async (_sessionPath, checkpoint) => ({
      events: [],
      checkpoint: checkpoint ?? { offset: 0 },
      reason: 'not_captured',
    }),
  };
}
