import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderGithubWikiWorkflow } from '../fork/github-wiki-workflow.js';
import { findTemplatesDir } from './templates.js';
import { isExperimentEnabled } from './experiments.js';
import { findProjectRoot } from '@plebeiantech/lat.md-core/project-discovery';

function readAgentTemplate(name: string, root?: string | null): string {
  return readFileSync(
    join(
      findTemplatesDir(),
      isExperimentEnabled('commit-hooks', root) ? 'experimental' : '.',
      name,
    ),
    'utf-8',
  );
}

export function readAgentsTemplate(root?: string | null): string {
  return readAgentTemplate('AGENTS.md', root);
}

export function readCursorRulesTemplate(root?: string | null): string {
  return readAgentTemplate('cursor-rules.md', root);
}

export function readPiExtensionTemplate(root?: string | null): string {
  return readAgentTemplate('pi-extension.ts', root);
}

export function readOpenCodePluginTemplate(root?: string | null): string {
  return readAgentTemplate('opencode-plugin.ts', root);
}

export function readSkillTemplate(): string {
  return readFileSync(join(findTemplatesDir(), 'skill', 'SKILL.md'), 'utf-8');
}

export async function genCmd(
  target: string,
  from?: string,
  options?: { branch?: string; nodeVersion?: string },
): Promise<void> {
  const root = findProjectRoot(from);
  const normalized = target.toLowerCase();
  switch (normalized) {
    case 'agents.md':
    case 'claude.md':
      process.stdout.write(readAgentsTemplate(root));
      break;
    case 'cursor-rules.md':
      process.stdout.write(readCursorRulesTemplate(root));
      break;
    case 'pi-extension.ts':
      process.stdout.write(readPiExtensionTemplate(root));
      break;
    case 'opencode-plugin.ts':
      process.stdout.write(readOpenCodePluginTemplate(root));
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
