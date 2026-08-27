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
  offerRequireMode,
  requireModeSet,
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

  // @lat: [[tests/fork-scaffold#Fork Scaffold#The flag merges into frontmatter that already exists]]
  it('merges into every frontmatter shape it can edit safely', () => {
    // A `lat:` mapping already there — insert a sibling, keeping its keys.
    expect(stampRequireMode('---\nlat:\n  tags: [x]\n---\n\nLead.\n')).toBe(
      '---\nlat:\n  require-mode: true\n  tags: [x]\n---\n\nLead.\n',
    );

    // Siblings must share indentation, so take it from the existing child.
    expect(
      stampRequireMode('---\nlat:\n    tags: [x]\n---\n\nLead.\n'),
    ).toBe('---\nlat:\n    require-mode: true\n    tags: [x]\n---\n\nLead.\n');

    // Frontmatter with no `lat:` key at all — add the mapping.
    expect(stampRequireMode('---\ntitle: X\n---\n\nLead.\n')).toBe(
      '---\ntitle: X\nlat:\n  require-mode: true\n---\n\nLead.\n',
    );

    // Already set, in any position — untouched.
    const set = '---\nlat:\n  require-mode: false\n---\n\nLead.\n';
    expect(stampRequireMode(set)).toBe(set);
  });

  // @lat: [[tests/fork-scaffold#Fork Scaffold#A flow mapping is refused rather than corrupted]]
  it('leaves a flow-mapping lat: key alone', () => {
    const flow = '---\nlat: {tags: [x]}\n---\n\nLead.\n';
    expect(stampRequireMode(flow)).toBe(flow);
    expect(requireModeSet(flow)).toBe(false);
  });

  // @lat: [[tests/fork-scaffold#Fork Scaffold#Existing frontmatter and listings are left alone]]
  it('does not list the mode directories twice', () => {
    const listed = 'Lead.\n\n- [Reference](reference/reference.md) — facts.\n';
    expect(listModeDirs(listed)).toBe(listed);
    expect(listModeDirs(listModeDirs('Lead.\n'))).toBe(listModeDirs('Lead.\n'));
  });

  // @lat: [[tests/fork-scaffold#Fork Scaffold#Successive runs converge]]
  it('is idempotent over repeated scaffolds', () => {
    const { root, latDir } = makeTree();
    try {
      scaffold(latDir);
      const once = readFileSync(join(latDir, 'lat.md'), 'utf-8');
      scaffold(latDir);
      scaffold(latDir);
      const thrice = readFileSync(join(latDir, 'lat.md'), 'utf-8');
      expect(thrice).toBe(once);
      expect(thrice.match(/^---$/gm)).toHaveLength(2);
      expect(thrice.match(/require-mode/g)).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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

describe('adopting the gate in an existing tree', () => {
  function existingTree(): { root: string; latDir: string } {
    const { root, latDir } = makeTree();
    writeFileSync(join(latDir, 'thermostats.md'), '# Thermostats\n\nState.\n');
    writeFileSync(join(latDir, 'decisions.md'), '# Decisions\n\nRationale.\n');
    return { root, latDir };
  }

  async function offer(
    latDir: string,
    interactive: boolean,
    answer: boolean,
  ): Promise<string[]> {
    const logs: string[] = [];
    const spy = vi
      .spyOn(console, 'log')
      .mockImplementation((...a: unknown[]) => {
        logs.push(a.join(' '));
      });
    try {
      await offerRequireMode(latDir, interactive, async () => answer);
    } finally {
      spy.mockRestore();
    }
    return logs;
  }

  // @lat: [[tests/fork-scaffold#Fork Scaffold#An existing tree is offered the gate]]
  it('turns the gate on and scaffolds when the answer is yes', async () => {
    const { root, latDir } = existingTree();
    try {
      const logs = await offer(latDir, true, true);
      expect(logs.join('\n')).toContain('2 document(s) would need a mode');
      const index = readFileSync(join(latDir, 'lat.md'), 'utf-8');
      expect(index).toContain('require-mode: true');
      expect(existsSync(join(latDir, 'reference', 'reference.md'))).toBe(true);
      expect((await checkMode(latDir, root)).length).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // @lat: [[tests/fork-scaffold#Fork Scaffold#Declining is remembered]]
  it('records a refusal and never asks again', async () => {
    const { root, latDir } = existingTree();
    try {
      await offer(latDir, true, false);
      expect(readFileSync(join(latDir, 'lat.md'), 'utf-8')).not.toContain(
        'require-mode',
      );

      const secondRun = await offer(latDir, true, true);
      expect(secondRun).toEqual([]);
      expect(readFileSync(join(latDir, 'lat.md'), 'utf-8')).not.toContain(
        'require-mode',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // @lat: [[tests/fork-scaffold#Fork Scaffold#Without a TTY the offer prints the edit instead]]
  it('prints the manual edit and records nothing when non-interactive', async () => {
    const { root, latDir } = existingTree();
    try {
      const logs = await offer(latDir, false, true);
      expect(logs.join('\n')).toContain('require-mode: true');
      expect(readFileSync(join(latDir, 'lat.md'), 'utf-8')).not.toContain(
        'require-mode',
      );

      // Nothing recorded, so a later interactive run still offers.
      const later = await offer(latDir, true, true);
      expect(later.length).toBeGreaterThan(0);
      expect(readFileSync(join(latDir, 'lat.md'), 'utf-8')).toContain(
        'require-mode: true',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // @lat: [[tests/fork-scaffold#Fork Scaffold#A tree that already opted in is not asked]]
  it('stays silent when the flag is already set', async () => {
    const { root, latDir } = existingTree();
    try {
      scaffold(latDir);
      expect(await offer(latDir, true, true)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
