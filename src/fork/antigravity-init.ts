import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { styleText } from 'node:util';
import { readSkillTemplate } from '../cli/gen.js';
import {
  readForkConventions,
  SKILL_FRONTMATTER,
} from '../cli/fork-instructions.js';

export function antigravityHooksTemplate(latBin: string): string {
  return (
    JSON.stringify(
      {
        'lat-md': {
          PreInvocation: [
            {
              type: 'command',
              command: `${latBin} hook antigravity PreInvocation`,
            },
          ],
          PreToolUse: [
            {
              matcher: 'replace_file_content|write_to_file',
              hooks: [
                {
                  type: 'command',
                  command: `${latBin} hook antigravity PreToolUse`,
                },
              ],
            },
          ],
          PostToolUse: [
            {
              matcher: 'replace_file_content|write_to_file',
              hooks: [
                {
                  type: 'command',
                  command: `${latBin} hook antigravity PostToolUse`,
                },
              ],
            },
          ],
          Stop: [
            {
              type: 'command',
              command: `${latBin} hook antigravity Stop`,
            },
          ],
        },
      },
      null,
      2,
    ) + '\n'
  );
}

export function mergeAntigravityHooks(
  existingRaw: string | null,
  latBin: string,
): string {
  let config: Record<string, unknown> = {};
  if (existingRaw) {
    try {
      const parsed = JSON.parse(existingRaw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        config = parsed as Record<string, unknown>;
      }
    } catch {
      try {
        const stripped = existingRaw
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/\/\/.*/g, '')
          .replace(/,\s*([}\]])/g, '$1');
        const parsed = JSON.parse(stripped);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          config = parsed as Record<string, unknown>;
        }
      } catch {
        config = {};
      }
    }
  }
  const template = JSON.parse(antigravityHooksTemplate(latBin));
  config['lat-md'] = template['lat-md'];
  return JSON.stringify(config, null, 2) + '\n';
}

export type SetupAntigravityOptions = {
  root: string;
  latDir: string;
  template: string;
  hashes: Record<string, string>;
  ask: (message: string) => Promise<boolean>;
  style: 'global' | 'local' | 'npx';
  latBin: string;
  appendTemplateSection: (
    root: string,
    latDir: string,
    relPath: string,
    template: string,
    label: string,
    indent: string,
    ask: (message: string) => Promise<boolean>,
  ) => Promise<string | null>;
  writeTemplateFile: (
    root: string,
    latDir: string,
    relPath: string,
    template: string,
    genTarget: string | null,
    label: string,
    indent: string,
    ask: (message: string) => Promise<boolean>,
  ) => Promise<string | null>;
  ensureGitignored: (root: string, entry: string) => void;
  hasMcpServer: (configPath: string, key: string) => boolean;
  addMcpServer: (
    configPath: string,
    key: string,
    style: 'global' | 'local' | 'npx',
  ) => void;
};

export async function setupAntigravity(
  opts: SetupAntigravityOptions,
): Promise<void> {
  const {
    root,
    latDir,
    template,
    hashes,
    ask,
    style,
    latBin,
    appendTemplateSection,
    writeTemplateFile,
    ensureGitignored,
    hasMcpServer,
    addMcpServer,
  } = opts;

  const geminiHash = await appendTemplateSection(
    root,
    latDir,
    'GEMINI.md',
    template,
    'GEMINI.md',
    '  ',
    ask,
  );
  if (geminiHash) hashes['GEMINI.md'] = geminiHash;

  console.log('');
  console.log(
    styleText(
      'dim',
      '  Antigravity hooks inject lat.md reminders into prompts, enforce the',
    ),
  );
  console.log(
    styleText(
      'dim',
      '  comment convention on edits, and block finishing on check failures.',
    ),
  );

  const existingHooksPath = join(root, '.agents/hooks.json');
  let hooksContent: string;
  if (existsSync(existingHooksPath)) {
    try {
      const existingRaw = readFileSync(existingHooksPath, 'utf-8');
      hooksContent = mergeAntigravityHooks(existingRaw, latBin);
    } catch {
      hooksContent = antigravityHooksTemplate(latBin);
    }
  } else {
    hooksContent = antigravityHooksTemplate(latBin);
  }

  const hooksHash = await writeTemplateFile(
    root,
    latDir,
    '.agents/hooks.json',
    hooksContent,
    null,
    'Hooks (.agents/hooks.json)',
    '  ',
    ask,
  );
  if (hooksHash) hashes['.agents/hooks.json'] = hooksHash;

  console.log('');
  console.log(
    styleText(
      'dim',
      '  The lat-md skills teach the agent how to write and maintain lat.md/ files.',
    ),
  );

  const skillTemplate = readSkillTemplate();
  const skillHash = await writeTemplateFile(
    root,
    latDir,
    '.agents/skills/lat-md/SKILL.md',
    skillTemplate,
    'skill.md',
    'Skill (.agents/skills/lat-md/SKILL.md)',
    '  ',
    ask,
  );
  if (skillHash) hashes['.agents/skills/lat-md/SKILL.md'] = skillHash;

  try {
    const conventionsSkill = `${SKILL_FRONTMATTER}${readForkConventions()}`;
    const conventionsHash = await writeTemplateFile(
      root,
      latDir,
      '.agents/skills/lat-md-conventions/SKILL.md',
      conventionsSkill,
      'skill.md',
      'Skill (.agents/skills/lat-md-conventions/SKILL.md)',
      '  ',
      ask,
    );
    if (conventionsHash) {
      hashes['.agents/skills/lat-md-conventions/SKILL.md'] = conventionsHash;
    }
  } catch {}

  ensureGitignored(root, '.gemini');

  const mcpPath = join(root, '.mcp.json');
  if (hasMcpServer(mcpPath, 'mcpServers')) {
    console.log(styleText('green', '  MCP server') + ' already configured');
  } else {
    addMcpServer(mcpPath, 'mcpServers', style);
    console.log(
      styleText('green', '  MCP server') + ' registered in .mcp.json',
    );
  }
  ensureGitignored(root, '.mcp.json');
}
