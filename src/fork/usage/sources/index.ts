import { antigravitySource } from './antigravity.js';
import { claudeSource } from './claude.js';
import { codexSource } from './codex.js';
import { opencodeSource } from './opencode.js';
import { piSource } from './pi.js';
import type { SessionSource } from './types.js';

export const sessionSources: SessionSource[] = [
  claudeSource,
  codexSource,
  piSource,
  opencodeSource,
  antigravitySource,
];
