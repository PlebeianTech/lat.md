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
import { parseFrontmatter } from '../src/lattice.js';
import {
  listModeDirs,
  offerRequireMode,
  planRequireMode,
  requireModeState,
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
  it('merges into every frontmatter shape that can hold a mapping key', () => {
    // A `lat:` mapping already there — add a sibling, keep its keys.
    expect(stampRequireMode('---\nlat:\n  tags: [x]\n---\n\nLead.\n')).toBe(
      '---\nlat:\n  tags: [x]\n  require-mode: true\n---\n\nLead.\n',
    );

    // Frontmatter with no `lat:` key at all — add the mapping.
    expect(stampRequireMode('---\ntitle: X\n---\n\nLead.\n')).toBe(
      '---\ntitle: X\nlat:\n  require-mode: true\n---\n\nLead.\n',
    );

    // A bare `lat:` beside a sibling list. Line surgery refused this one: its
    // scan for the mapping's first child walked past the end of the block and
    // found `- ada`, which belongs to `authors:`.
    expect(
      stampRequireMode('---\nlat:\nauthors:\n  - ada\n---\n\nLead.\n'),
    ).toBe(
      '---\nlat:\n  require-mode: true\nauthors:\n  - ada\n---\n\nLead.\n',
    );

    // A flow mapping and an anchor both merge; both used to be refused.
    expect(stampRequireMode('---\nlat: {tags: [x]}\n---\n\nLead.\n')).toBe(
      '---\nlat: {tags: [x], require-mode: true}\n---\n\nLead.\n',
    );
    expect(stampRequireMode('---\nlat: &a\n  tags: [x]\n---\n\nLead.\n')).toBe(
      '---\nlat: &a\n  tags: [x]\n  require-mode: true\n---\n\nLead.\n',
    );

    // Closed with `----`. This is frontmatter to the parser, so it has to be
    // frontmatter here too — prepending a second block above it orphans every
    // field the first one declared while leaving it in the file.
    expect(
      stampRequireMode('---\nlat:\n  a: 1\n----\n\nLead.\n'),
    ).toBe('---\nlat:\n  a: 1\n  require-mode: true\n----\n\nLead.\n');

    // Comments survive the round trip.
    expect(
      stampRequireMode('---\n# why\nlat:\n  tags: [x] # keep\n---\n\nLead.\n'),
    ).toContain('# why');
  });

  // @lat: [[tests/fork-scaffold#Fork Scaffold#An explicit answer is left alone]]
  it('reads the flag as four states and leaves a decided one alone', () => {
    const on = '---\nlat:\n  require-mode: true\n---\n\nLead.\n';
    const off = '---\nlat:\n  require-mode: false\n---\n\nLead.\n';
    const loose = '---\nlat:\n  require-mode: yes\n---\n\nLead.\n';

    expect(requireModeState(on)).toBe('on');
    expect(requireModeState(off)).toBe('off');
    expect(requireModeState(loose)).toBe('invalid');
    expect(requireModeState('---\nlat:\n  tags: [x]\n---\n')).toBe('unset');

    // `false` is an answer, not an absence, so it is never overwritten.
    expect(stampRequireMode(off)).toBe(off);
    // `yes` is a string to a YAML 1.2 parser. Treating it as set would agree
    // with nothing: `checkMode` enforces on `=== true` and would stay off.
    expect(planRequireMode(loose).kind).toBe('invalid');
  });

  // @lat: [[tests/fork-scaffold#Fork Scaffold#A shape it cannot edit is refused rather than corrupted]]
  it('refuses only what cannot hold a key, and never loses a field', () => {
    for (const shape of [
      '---\nlat:\n  - a\n  - b\n---\n\nLead.\n', // a list takes no key
      '---\nlat: hello\n---\n\nLead.\n', // nor does a scalar
    ]) {
      expect(stampRequireMode(shape)).toBe(shape);
      expect(planRequireMode(shape).kind).toBe('unsupported');
    }

    // Frontmatter that does not parse is named, not edited: every `lat:` field
    // on such a document is already being ignored.
    const tabs = '---\nlat:\n\ttags: x\n---\n\nLead.\n';
    const plan = planRequireMode(tabs);
    expect(plan.kind).toBe('unparseable');
    expect(plan.kind === 'unparseable' && plan.detail).toMatch(/Tabs/);

    // The guarantee, stated independently of which shapes were anticipated:
    // whatever comes back parses, and every field that was read before is read
    // back the same afterwards. An edit that sets the gate and drops
    // `require-code-mention` turns one check on and another silently off.
    for (const shape of [
      '---\nlat: {tags: [x]}\n---\n\nLead.\n',
      '---\nlat:\n  - a\n  - b\n---\n\nLead.\n',
      '---\nlat:\n  tags: [x]\n---\n\nLead.\n',
      '---\nlat:\n  require-code-mention: true\n----\n\nLead.\n',
      '---\nlat:\n\ttags: x\n---\n\nLead.\n',
      '---\nlat: &a\n  tags: [x]\n---\n\nLead.\n',
      '---\ntitle: X\n---\n\nLead.\n',
      'No frontmatter at all.\n',
    ]) {
      const before = parseFrontmatter(shape);
      const after = parseFrontmatter(stampRequireMode(shape));
      const broke = (fm: typeof before): boolean =>
        (fm.problems ?? []).some((p) => p.kind === 'parse-error');
      // Never *introduces* one. A document that already did not parse is left
      // exactly as it was, and reported rather than edited.
      expect(broke(after)).toBe(broke(before));
      for (const [key, value] of Object.entries(before.raw)) {
        if (key === 'require-mode') continue;
        expect(after.raw[key]).toEqual(value);
      }
    }
  });

  // @lat: [[tests/fork-scaffold#Fork Scaffold#A root-level flag does not count as set]]
  it('moves a stray root-level flag rather than shadowing it', () => {
    const stray = '---\nrequire-mode: true\n---\n\nLead.\n';
    expect(requireModeState(stray)).toBe('unset');
    expect(parseFrontmatter(stray).problems).toEqual([
      { kind: 'root-level-field', field: 'require-mode' },
    ]);

    const out = stampRequireMode(stray);
    expect(requireModeState(out)).toBe('on');
    // Writing the nested key silences `checkFrontmatter`'s misplacement report
    // for that field, so leaving the dead key behind would end the one message
    // that would ever have mentioned it.
    expect(out).toBe('---\nlat:\n  require-mode: true\n---\n\nLead.\n');
  });

  // @lat: [[tests/fork-scaffold#Fork Scaffold#Nothing is restructured when the gate cannot land]]
  it('leaves the tree alone when the gate cannot be written', () => {
    const { root, latDir } = makeTree();
    try {
      const unstampable = '---\nlat:\n  - a\n---\n\n# Bella\n\nLead.\n';
      writeFileSync(join(latDir, 'lat.md'), unstampable);
      scaffold(latDir);
      // Four directories plus a listing but no gate reads as adopted to
      // `checkMode` and as a broken index to `lat check index`. Neither is
      // better than doing nothing.
      expect(readFileSync(join(latDir, 'lat.md'), 'utf-8')).toBe(unstampable);
      expect(existsSync(join(latDir, 'reference'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // @lat: [[tests/fork-scaffold#Fork Scaffold#Existing frontmatter and listings are left alone]]
  it('lists the mode directories that are missing and no others', () => {
    // One already linked: the other three still have to be, or the run leaves
    // three directories that no index points at and `lat check index` fails.
    const listed = 'Lead.\n\n- [Reference](reference/reference.md) — facts.\n';
    const filled = listModeDirs(listed);
    expect(filled).toContain('[Tutorials](tutorials/tutorials.md)');
    expect(filled.match(/reference\/reference\.md/g)).toHaveLength(1);
    expect(listModeDirs(filled)).toBe(filled);
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

describe('the offer terminates', () => {
  async function offerOn(
    rootIndex: string,
    runs: number,
  ): Promise<{ prompts: number; latDir: string; root: string }> {
    const root = mkdtempSync(join(tmpdir(), 'lat-terminate-'));
    const latDir = join(root, 'lat.md');
    mkdirSync(latDir, { recursive: true });
    writeFileSync(join(latDir, 'lat.md'), rootIndex);
    writeFileSync(join(latDir, 'doc.md'), '# Doc\n\nA document.\n');
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    let prompts = 0;
    try {
      for (let i = 0; i < runs; i++) {
        await offerRequireMode(latDir, true, async () => {
          prompts++;
          return true;
        });
      }
    } finally {
      spy.mockRestore();
    }
    return { prompts, latDir, root };
  }

  // @lat: [[tests/fork-scaffold#Fork Scaffold#An unsupported shape is never asked about]]
  it('never asks about a shape it cannot edit, and changes nothing', async () => {
    const shape = '---\nlat:\n  - a\n  - b\n---\n\n# Bella\n\nRoot index.\n';
    const { prompts, latDir, root } = await offerOn(shape, 3);
    try {
      // Asked first and refused afterwards, this cost a tree four directories
      // and a rewritten index in exchange for a gate that never landed — and
      // then recorded the failure, so the offer never returned.
      expect(prompts).toBe(0);
      expect(readFileSync(join(latDir, 'lat.md'), 'utf-8')).toBe(shape);
      expect(existsSync(join(latDir, 'reference'))).toBe(false);
      expect(existsSync(join(latDir, '.cache', 'lat_fork.json'))).toBe(false);

      // Nothing was recorded, so repairing the frontmatter is enough: the very
      // next run offers, which is the only thing that makes the printed advice
      // worth printing.
      writeFileSync(
        join(latDir, 'lat.md'),
        '---\nlat:\n  tags: [a]\n---\n\n# Bella\n\nRoot index.\n',
      );
      let asked = 0;
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        await offerRequireMode(latDir, true, async () => {
          asked++;
          return true;
        });
      } finally {
        spy.mockRestore();
      }
      expect(asked).toBe(1);
      expect(requireModeState(readFileSync(join(latDir, 'lat.md'), 'utf-8'))).toBe(
        'on',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // @lat: [[tests/fork-scaffold#Fork Scaffold#Every editable shape is asked about once]]
  it('asks once and lands the flag on every shape it can edit', async () => {
    for (const shape of [
      '# Bella\n\nRoot index.\n',
      '---\nlat:\n  tags: [x]\n---\n\n# Bella\n\nRoot index.\n',
      '---\nlat:\n    tags: [x]\n---\n\n# Bella\n\nRoot index.\n',
      '---\ntitle: Bella\n---\n\n# Bella\n\nRoot index.\n',
      '---\nrequire-mode: true\n---\n\n# Bella\n\nRoot index.\n',
      '---\nlat: {tags: [x]}\n---\n\n# Bella\n\nRoot index.\n',
      '---\nlat: &a\n  tags: [x]\n---\n\n# Bella\n\nRoot index.\n',
      '---\nlat:\nauthors:\n  - ada\n---\n\n# Bella\n\nRoot index.\n',
    ]) {
      const { prompts, latDir, root } = await offerOn(shape, 3);
      try {
        expect(prompts).toBe(1);
        const index = readFileSync(join(latDir, 'lat.md'), 'utf-8');
        expect(requireModeState(index)).toBe('on');
        expect(index.match(/require-mode/g)?.length ?? 0).toBeLessThanOrEqual(2);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  // @lat: [[tests/fork-scaffold#Fork Scaffold#The count is what adoption would newly cost]]
  it('counts only errors the gate would newly cause', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lat-count-'));
    const latDir = join(root, 'lat.md');
    mkdirSync(latDir, { recursive: true });
    mkdirSync(join(latDir, 'reference'), { recursive: true });
    writeFileSync(join(latDir, 'lat.md'), '# Bella\n\nRoot index.\n');
    writeFileSync(
      join(latDir, 'reference', 'reference.md'),
      '# Reference\n\nLookup facts.\n',
    );
    // Two documents with byte-identical frontmatter, one flat and one inside a
    // mode directory. Both are already errors, so neither is a cost of
    // adopting the gate — the hand-rolled count reported one of them and
    // skipped the other purely on where it sat.
    const broken = '---\nlat:\n  mode: guide\n---\n\n# G\n\nA document.\n';
    writeFileSync(join(latDir, 'guide.md'), broken);
    writeFileSync(join(latDir, 'reference', 'guide.md'), broken);
    // This one is a cost: fine today, an error once the gate is on.
    writeFileSync(join(latDir, 'flat.md'), '# Flat\n\nA document.\n');

    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      logs.push(a.join(' '));
    });
    try {
      await offerRequireMode(latDir, true, async () => false);
      expect(logs.join('\n')).toContain('1 document(s) would need a mode');
      expect(logs.join('\n')).toContain('flat');
      // Already broken either way, and `lat check` says so with or without it.
      expect((await checkMode(latDir, root)).length).toBe(2);
    } finally {
      spy.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  // @lat: [[tests/fork-scaffold#Fork Scaffold#A flag value that is neither true nor false is reported]]
  it('reports a require-mode value the checker will not act on', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lat-flag-'));
    const latDir = join(root, 'lat.md');
    mkdirSync(latDir, { recursive: true });
    writeFileSync(
      join(latDir, 'lat.md'),
      '---\nlat:\n  require-mode: yes\n---\n\n# Bella\n\nRoot index.\n',
    );
    writeFileSync(join(latDir, 'flat.md'), '# Flat\n\nA document.\n');
    try {
      const errors = await checkMode(latDir, root);
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toContain('must be true or false');
      // Enforced as off, which is the half that used to happen in silence.
      expect(errors[0].message).toContain('not running');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
