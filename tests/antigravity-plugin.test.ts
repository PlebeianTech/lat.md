import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('antigravity plugin bundle', () => {
  const pluginDir = join(import.meta.dirname, '..', 'plugins', 'lat-md');

  it('provides a valid plugin.json manifest', () => {
    const manifestPath = join(pluginDir, 'plugin.json');
    expect(existsSync(manifestPath)).toBe(true);

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    expect(manifest.name).toBe('lat-md');
    expect(manifest.description).toBeDefined();
    expect(manifest.author?.name).toBe('PlebeianTech');
    expect(manifest.keywords).toContain('lat.md');
  });

  it('provides a valid hooks.json config with all 4 lifecycle events', () => {
    const hooksPath = join(pluginDir, 'hooks.json');
    expect(existsSync(hooksPath)).toBe(true);

    const hooks = JSON.parse(readFileSync(hooksPath, 'utf-8'));
    expect(hooks['lat-md']).toBeDefined();
    expect(hooks['lat-md'].PreInvocation).toBeDefined();
    expect(hooks['lat-md'].PreToolUse).toBeDefined();
    expect(hooks['lat-md'].PostToolUse).toBeDefined();
    expect(hooks['lat-md'].Stop).toBeDefined();
  });

  it('provides rules in rules/AGENTS.md', () => {
    const rulesPath = join(pluginDir, 'rules', 'AGENTS.md');
    expect(existsSync(rulesPath)).toBe(true);
    const content = readFileSync(rulesPath, 'utf-8');
    expect(content).toContain('What is lat.md?');
    expect(content).toContain('lat check');
  });

  it('provides skills with valid frontmatter', () => {
    const latMdSkill = join(pluginDir, 'skills', 'lat-md', 'SKILL.md');
    expect(existsSync(latMdSkill)).toBe(true);
    const latMdContent = readFileSync(latMdSkill, 'utf-8');
    expect(latMdContent).toMatch(/^---\nname:\s*lat-md/);

    const conventionsSkill = join(
      pluginDir,
      'skills',
      'lat-md-conventions',
      'SKILL.md',
    );
    expect(existsSync(conventionsSkill)).toBe(true);
    const convContent = readFileSync(conventionsSkill, 'utf-8');
    expect(convContent).toMatch(/^---\nname:\s*lat-md-conventions/);
  });
});
