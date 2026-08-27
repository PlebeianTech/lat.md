import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkCoverage } from '../src/cli/check-coverage.js';

const ROOT_INDEX = '# Demo\n\nThe root index for a fixture project.\n';

function makeProject(opts: {
  documents?: Record<string, string>;
  sources?: Record<string, string>;
  rootIndex?: string;
}): { root: string; latDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'lat-coverage-'));
  const latDir = join(root, 'lat.md');
  mkdirSync(latDir, { recursive: true });
  writeFileSync(join(latDir, 'lat.md'), opts.rootIndex ?? ROOT_INDEX);
  for (const [name, body] of Object.entries(opts.documents ?? {})) {
    const target = join(latDir, name);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, body);
  }
  for (const [name, body] of Object.entries(opts.sources ?? {})) {
    const target = join(root, name);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, body);
  }
  return { root, latDir };
}

async function run(opts: Parameters<typeof makeProject>[0]) {
  const { root, latDir } = makeProject(opts);
  try {
    return await checkCoverage(latDir, root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('code-ref coverage floor', () => {
  // @lat: [[tests/check-coverage#Check Coverage#A documented tree with no refs fails]]
  it('reports a tree that has documents and no ref anywhere', async () => {
    const errors = await run({
      documents: { 'widgets.md': '# Widgets\n\nThe widget subsystem.\n' },
      sources: { 'src/index.ts': 'export const x = 1;\n' },
    });
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('no `@lat:` code ref anywhere');
  });

  // @lat: [[tests/check-coverage#Check Coverage#One ref anywhere clears it]]
  it('passes as soon as a single ref exists', async () => {
    const errors = await run({
      documents: { 'widgets.md': '# Widgets\n\nThe widget subsystem.\n' },
      sources: { 'src/index.ts': '// @lat: [[widgets#Widgets]]\nexport const x = 1;\n' },
    });
    expect(errors).toEqual([]);
  });

  // @lat: [[tests/check-coverage#Check Coverage#A ref in any comment syntax counts]]
  it('counts a ref written with a hash marker in a Ruby file', async () => {
    const errors = await run({
      documents: { 'widgets.md': '# Widgets\n\nThe widget subsystem.\n' },
      sources: {
        'config/application.rb': '# @lat: [[lat#Demo]]\nmodule Demo\nend\n',
      },
    });
    expect(errors).toEqual([]);
  });

  // @lat: [[tests/check-coverage#Check Coverage#An index-only tree is not asked for a ref]]
  it('stays silent when every file is a directory index', async () => {
    const errors = await run({
      documents: { 'guides/guides.md': '# Guides\n\nAn index and nothing else.\n' },
      sources: { 'src/index.ts': 'export const x = 1;\n' },
    });
    expect(errors).toEqual([]);
  });

  // @lat: [[tests/check-coverage#Check Coverage#A project with no scannable code is not asked for a ref]]
  it('stays silent when there is no code to anchor from', async () => {
    const errors = await run({
      documents: { 'widgets.md': '# Widgets\n\nThe widget subsystem.\n' },
    });
    expect(errors).toEqual([]);
  });

  // @lat: [[tests/check-coverage#Check Coverage#The remediation quotes a ref that resolves]]
  it('names the root index heading rather than a placeholder', async () => {
    const errors = await run({
      documents: { 'widgets.md': '# Widgets\n\nThe widget subsystem.\n' },
      sources: { 'src/index.ts': 'export const x = 1;\n' },
      rootIndex: '# Acme Payments\n\nRoot index.\n',
    });
    expect(errors[0].message).toContain('[[lat#Acme Payments]]');
  });

  // @lat: [[tests/check-coverage#Check Coverage#The message answers both reasons an agent skips the ref]]
  it('states the comment-convention exemption and the language correction', async () => {
    const errors = await run({
      documents: { 'widgets.md': '# Widgets\n\nThe widget subsystem.\n' },
      sources: { 'src/index.ts': 'export const x = 1;\n' },
    });
    expect(errors[0].message).toContain('not a language allowlist');
    expect(errors[0].message).toContain('machine directive');
  });
});
