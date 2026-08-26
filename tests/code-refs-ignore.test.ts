import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { scanCodeRefs } from '../src/code-refs.js';

// lat-t1y.38: `lat:ignore` opt-out must not match as a bare substring.
//
// A line mentioning `lat:ignore-config` (or any word merely starting with
// the substring "lat:ignore") should keep its @lat: reference. Only a
// standalone `lat:ignore` token should opt a line out.

const casesDir = join(import.meta.dirname, 'cases');

function caseDir(name: string): string {
  return join(casesDir, name);
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
