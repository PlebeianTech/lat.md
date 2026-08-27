import { describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkMode } from '../src/cli/check-mode.js';
import {
  listModeDirs,
  stampRequireMode,
  writeForkScaffold,
} from '../src/cli/fork-scaffold.js';

const ROOT_INDEX =
  'This directory defines the high-level concepts of this project.\n';

function makeTree(): { root: string; latDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'lat-fork-scaffold-'));
  const latDir = join(root, 'lat.md');
  mkdirSync(latDir, { recursive: true });
  writeFileSync(join(latDir, 'lat.md'), ROOT_INDEX);
  return { root, latDir };
}

function scaffold(latDir: string): void {
  const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    writeForkScaffold(latDir);
  } finally {
    spy.mockRestore();
  }
}

describe('fork Diátaxis scaffold', () => {
  // @lat: [[tests/fork-scaffold#Fork Scaffold#A fresh tree gets four mode directories]]
  it('creates the four mode directories with indexes that pass their own mode', async () => {
    const { root, latDir } = makeTree();
    try {
      scaffold(latDir);
      for (const dir of ['tutorials', 'how-to', 'reference', 'explanation']) {
        expect(existsSync(join(latDir, dir, `${dir}.md`))).toBe(true);
      }
      expect(await checkMode(latDir, root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // @lat: [[tests/fork-scaffold#Fork Scaffold#The gate is stamped into the root index]]
  it('stamps require-mode and lists the directories in the root index', () => {
    const { root, latDir } = makeTree();
    try {
      scaffold(latDir);
      const index = readFileSync(join(latDir, 'lat.md'), 'utf-8');
      expect(index).toMatch(/^---\nlat:\n {2}require-mode: true\n---\n/);
      expect(index).toContain('[Reference](reference/reference.md)');
      expect(index).toContain(ROOT_INDEX.trim());
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // @lat: [[tests/fork-scaffold#Fork Scaffold#Existing frontmatter and listings are left alone]]
  it('never rewrites a root index that already has frontmatter or the listing', () => {
    const withFm = '---\nlat:\n  tags: [x]\n---\n\nLead.\n';
    expect(stampRequireMode(withFm)).toBe(withFm);

    const listed = 'Lead.\n\n- [Reference](reference/reference.md) — facts.\n';
    expect(listModeDirs(listed)).toBe(listed);
  });

  // @lat: [[tests/fork-scaffold#Fork Scaffold#Re-scaffolding keeps a directory the user changed]]
  it('leaves an existing mode index untouched', () => {
    const { root, latDir } = makeTree();
    try {
      mkdirSync(join(latDir, 'reference'), { recursive: true });
      writeFileSync(join(latDir, 'reference', 'reference.md'), '# Mine\n\nX.\n');
      scaffold(latDir);
      expect(readFileSync(join(latDir, 'reference', 'reference.md'), 'utf-8')).toBe(
        '# Mine\n\nX.\n',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('require-mode gate', () => {
  // @lat: [[tests/fork-scaffold#Fork Scaffold#A flat document fails once the gate is on]]
  it('reports a document with no mode and no mode directory', async () => {
    const { root, latDir } = makeTree();
    try {
      scaffold(latDir);
      writeFileSync(join(latDir, 'thermostats.md'), '# Thermostats\n\nState.\n');
      const errors = await checkMode(latDir, root);
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toContain('declares no Diátaxis mode');
      expect(errors[0].file).toContain('thermostats.md');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // @lat: [[tests/fork-scaffold#Fork Scaffold#A declared mode satisfies the gate without moving the file]]
  it('accepts a flat document that declares its mode', async () => {
    const { root, latDir } = makeTree();
    try {
      scaffold(latDir);
      writeFileSync(
        join(latDir, 'thermostats.md'),
        '---\nlat:\n  mode: explanation\n---\n\n# Thermostats\n\nWhy the guardrail exists.\n',
      );
      expect(await checkMode(latDir, root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // @lat: [[tests/fork-scaffold#Fork Scaffold#Directory indexes are never asked for a mode]]
  it('exempts index files at every depth', async () => {
    const { root, latDir } = makeTree();
    try {
      scaffold(latDir);
      mkdirSync(join(latDir, 'domain'), { recursive: true });
      writeFileSync(join(latDir, 'domain', 'domain.md'), '# Domain\n\nIndex.\n');
      expect(await checkMode(latDir, root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // @lat: [[tests/fork-scaffold#Fork Scaffold#A tree without the flag is unchanged]]
  it('stays silent when the root index does not opt in', async () => {
    const { root, latDir } = makeTree();
    try {
      writeFileSync(join(latDir, 'thermostats.md'), '# Thermostats\n\nState.\n');
      expect(await checkMode(latDir, root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
