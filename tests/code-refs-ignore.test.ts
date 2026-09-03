import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { scanCodeRefs, hasRipgrep } from '../src/code-refs.js';
import { checkCodeRefs } from '../src/cli/check.js';

// lat-t1y.38: `lat:ignore` opt-out must not match as a bare substring.
//
// A line mentioning `lat:ignore-config` (or any word merely starting with
// the substring "lat:ignore") should keep its @lat: reference. Only a
// standalone `lat:ignore` token should opt a line out.

const casesDir = join(import.meta.dirname, 'cases');

function caseDir(name: string): string {
  return join(casesDir, name);
}

function latDir(name: string): string {
  return join(casesDir, name, 'lat.md');
}

describe('coderefs-ignore-substring', () => {
  it('keeps a ref on a line that merely contains "lat:ignore" as a substring', async () => {
    const { refs } = await scanCodeRefs(caseDir('coderefs-ignore-substring'));
    const targets = refs.map((r) => r.target);
    expect(targets).toContain('Specs#Config Ref');
  });

  it('still honors a genuine standalone lat:ignore opt-out', async () => {
    const { refs } = await scanCodeRefs(caseDir('coderefs-ignore-substring'));
    const targets = refs.map((r) => r.target);
    expect(targets).not.toContain('Specs#Real Opt Out');
  });

  it('honors lat:ignore glued directly to a comment marker (//lat:ignore)', async () => {
    const { refs } = await scanCodeRefs(caseDir('coderefs-ignore-substring'));
    const targets = refs.map((r) => r.target);
    expect(targets).not.toContain('Specs#Glued Ref');
  });

  it('finds exactly the one legitimate ref in the fixture', async () => {
    const { refs } = await scanCodeRefs(caseDir('coderefs-ignore-substring'));
    expect(refs).toHaveLength(1);
    expect(refs[0].target).toBe('Specs#Config Ref');
  });
});

// --- literal-example-code-ref ---

describe('literal-example-code-ref', () => {
  async function expectOnlyRealRef(usedRg: boolean) {
    const { refs } = await scanCodeRefs(caseDir('literal-example-code-ref'));
    expect(refs).toHaveLength(1);
    expect(refs[0].target).toBe('Specs#Real Ref');
    expect(refs[0].line).toBe(1);
  }

  it('finds a real ref but skips markers in string/backtick literals and lat:ignore lines (ts fallback)', async () => {
    process.env._LAT_DISABLE_RG = '1';
    try {
      await expectOnlyRealRef(false);
    } finally {
      delete process.env._LAT_DISABLE_RG;
    }
  });

  it('agrees with the ripgrep fast path when rg is available', async () => {
    const usedRg = await hasRipgrep();
    if (!usedRg) return; // rg not installed; ts-fallback case above already covers behavior
    // ScanResult no longer reports which path ran, but rg is installed and
    // _LAT_DISABLE_RG is unset here, so this is the ripgrep path by construction.
    const { refs } = await scanCodeRefs(caseDir('literal-example-code-ref'));
    expect(refs).toHaveLength(1);
    expect(refs[0].target).toBe('Specs#Real Ref');
  });

  it('passes lat check with only the real ref resolved', async () => {
    const { errors } = await checkCodeRefs(latDir('literal-example-code-ref'));
    expect(errors).toHaveLength(0);
  });
});

describe('antigravity directory exclusion', () => {
  it('excludes .gemini and .agents from code reference scanning', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'lat-agy-ignore-'));
    try {
      mkdirSync(join(dir, '.gemini'), { recursive: true });
      mkdirSync(join(dir, '.agents'), { recursive: true });
      mkdirSync(join(dir, 'src'), { recursive: true });

      writeFileSync(
        join(dir, '.gemini', 'state.ts'),
        '// @lat: [[lat.md/topic#Gemini Ref]]\n',
      );
      writeFileSync(
        join(dir, '.agents', 'rules.ts'),
        '// @lat: [[lat.md/topic#Agents Ref]]\n',
      );
      writeFileSync(
        join(dir, 'src', 'app.ts'),
        '// @lat: [[lat.md/topic#App Ref]]\n',
      );

      const { refs } = await scanCodeRefs(dir);
      const targets = refs.map((r) => r.target);
      expect(targets).toContain('lat.md/topic#App Ref');
      expect(targets).not.toContain('lat.md/topic#Gemini Ref');
      expect(targets).not.toContain('lat.md/topic#Agents Ref');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

