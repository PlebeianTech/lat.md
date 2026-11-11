import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderGithubWikiWorkflow } from '../fork/github-wiki-workflow.js';
import { findTemplatesDir } from './templates.js';

export function readAgentsTemplate(): string {
  return readFileSync(join(findTemplatesDir(), 'AGENTS.md'), 'utf-8');
}

export function readCursorRulesTemplate(): string {
  return readFileSync(join(findTemplatesDir(), 'cursor-rules.md'), 'utf-8');
}

export function readPiExtensionTemplate(): string {
  return readFileSync(join(findTemplatesDir(), 'pi-extension.ts'), 'utf-8');
}

export function readOpenCodePluginTemplate(): string {
  return readFileSync(join(findTemplatesDir(), 'opencode-plugin.ts'), 'utf-8');
}

export function readSkillTemplate(): string {
  return readFileSync(join(findTemplatesDir(), 'skill', 'SKILL.md'), 'utf-8');
}

export async function genCmd(
  target: string,
  options?: { branch?: string; nodeVersion?: string },
): Promise<void> {
  const normalized = target.toLowerCase();
  switch (normalized) {
    case 'agents.md':
    case 'claude.md':
      process.stdout.write(readAgentsTemplate());
      break;
    case 'cursor-rules.md':
      process.stdout.write(readCursorRulesTemplate());
      break;
    case 'pi-extension.ts':
      process.stdout.write(readPiExtensionTemplate());
      break;
    case 'opencode-plugin.ts':
      process.stdout.write(readOpenCodePluginTemplate());
      break;
    case 'skill.md':
      process.stdout.write(readSkillTemplate());
      break;
    case 'github-wiki-workflow':
      process.stdout.write(renderGithubWikiWorkflow(options));
      break;
    default:
      console.error(
        `Unknown target: ${target}. Supported: agents.md, claude.md, cursor-rules.md, pi-extension.ts, opencode-plugin.ts, skill.md, github-wiki-workflow`,
      );
      process.exit(1);
  }
}
