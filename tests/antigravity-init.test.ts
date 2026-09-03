import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  antigravityHooksTemplate,
  mergeAntigravityHooks,
  setupAntigravity,
} from '../src/fork/antigravity-init.js';

describe('antigravity init', () => {
  describe('antigravityHooksTemplate', () => {
    it('generates hooks JSON with all 4 lifecycle events and tool matchers', () => {
      const template = antigravityHooksTemplate('lat');
      const parsed = JSON.parse(template);

      expect(parsed['lat-md']).toBeDefined();
      expect(parsed['lat-md'].PreInvocation).toHaveLength(1);
      expect(parsed['lat-md'].PreInvocation[0].command).toBe(
        'lat hook antigravity PreInvocation',
      );

      expect(parsed['lat-md'].PreToolUse).toHaveLength(1);
      expect(parsed['lat-md'].PreToolUse[0].matcher).toBe(
        'replace_file_content|write_to_file',
      );
      expect(parsed['lat-md'].PreToolUse[0].hooks[0].command).toBe(
        'lat hook antigravity PreToolUse',
      );

      expect(parsed['lat-md'].PostToolUse).toHaveLength(1);
      expect(parsed['lat-md'].PostToolUse[0].matcher).toBe(
        'replace_file_content|write_to_file',
      );
      expect(parsed['lat-md'].PostToolUse[0].hooks[0].command).toBe(
        'lat hook antigravity PostToolUse',
      );

      expect(parsed['lat-md'].Stop).toHaveLength(1);
      expect(parsed['lat-md'].Stop[0].command).toBe('lat hook antigravity Stop');
    });
  });

  describe('mergeAntigravityHooks', () => {
    it('preserves existing third party hooks in hooks.json', () => {
      const existing = JSON.stringify({
        'my-custom-linter': {
          PreToolUse: [{ type: 'command', command: 'run-linter' }],
        },
      });

      const merged = mergeAntigravityHooks(existing, 'lat');
      const parsed = JSON.parse(merged);

      expect(parsed['my-custom-linter']).toBeDefined();
      expect(parsed['lat-md']).toBeDefined();
      expect(parsed['lat-md'].PreInvocation).toHaveLength(1);
    });

    it('handles null or corrupted existing content gracefully', () => {
      const merged = mergeAntigravityHooks('invalid-json', 'lat');
      const parsed = JSON.parse(merged);
      expect(parsed['lat-md']).toBeDefined();
    });

    it('handles JSONC with comments and trailing commas', () => {
      const jsonc = `{\n  // Line comment\n  "my-tool": {\n    /* Block comment */\n    "PreToolUse": [],\n  },\n}`;
      const merged = mergeAntigravityHooks(jsonc, 'lat');
      const parsed = JSON.parse(merged);
      expect(parsed['my-tool']).toBeDefined();
      expect(parsed['lat-md']).toBeDefined();
    });

    it('handles literal null string gracefully without throwing', () => {
      const merged = mergeAntigravityHooks('null', 'lat');
      const parsed = JSON.parse(merged);
      expect(parsed['lat-md']).toBeDefined();
    });
  });

  describe('setupAntigravity', () => {
    it('scaffolds GEMINI.md, .agents/hooks.json, skills, and .mcp.json', async () => {
      const root = mkdtempSync(join(tmpdir(), 'lat-agy-init-'));
      const latDir = join(root, 'lat.md');
      mkdirSync(latDir, { recursive: true });

      const gitignored: string[] = [];
      const mcpConfigs: Record<string, unknown> = {};

      try {
        const hashes: Record<string, string> = {};
        await setupAntigravity({
          root,
          latDir,
          template: '# Instructions\n',
          hashes,
          ask: async () => true,
          style: 'global',
          latBin: 'lat',
          appendTemplateSection: async (_root, _latDir, relPath, content) => {
            const { writeFileSync, mkdirSync } = await import('node:fs');
            const abs = join(root, relPath);
            mkdirSync(join(abs, '..'), { recursive: true });
            writeFileSync(abs, content);
            return 'hash-template';
          },
          writeTemplateFile: async (_root, _latDir, relPath, content) => {
            const { writeFileSync, mkdirSync } = await import('node:fs');
            const abs = join(root, relPath);
            mkdirSync(join(abs, '..'), { recursive: true });
            writeFileSync(abs, content);
            return 'hash-written';
          },
          ensureGitignored: (_root, entry) => {
            gitignored.push(entry);
          },
          hasMcpServer: () => false,
          addMcpServer: (_path, key) => {
            mcpConfigs[key] = { command: 'lat', args: ['mcp'] };
          },
        });

        expect(existsSync(join(root, 'GEMINI.md'))).toBe(true);
        expect(existsSync(join(root, '.agents', 'hooks.json'))).toBe(true);
        expect(
          existsSync(join(root, '.agents', 'skills', 'lat-md', 'SKILL.md')),
        ).toBe(true);
        expect(
          existsSync(
            join(root, '.agents', 'skills', 'lat-md-conventions', 'SKILL.md'),
          ),
        ).toBe(true);

        const hooks = JSON.parse(
          readFileSync(join(root, '.agents', 'hooks.json'), 'utf-8'),
        );
        expect(hooks['lat-md']).toBeDefined();

        expect(gitignored).toContain('.gemini');
        expect(gitignored).toContain('.mcp.json');
        expect(mcpConfigs.mcpServers).toBeDefined();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });
});
