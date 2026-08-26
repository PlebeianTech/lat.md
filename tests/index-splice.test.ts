import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { mkdtemp, cp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { checkIndex } from '../src/cli/check.js';

const casesDir = join(import.meta.dirname, 'cases');

function caseDir(name: string): string {
  return join(casesDir, name);
}

async function withTmpCopy<T>(
  caseName: string,
  fn: (latDirPath: string) => Promise<T>,
): Promise<T> {
  const tmpRoot = await mkdtemp(join(tmpdir(), 'lat-index-splice-'));
  await cp(caseDir(caseName), tmpRoot, { recursive: true });
  try {
    return await fn(join(tmpRoot, 'lat.md'));
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
}

describe('index-splice-below', () => {
  // @lat: [[check-index#Splicing preserves hand-written content#Hand-written content below the generated list survives]]
  it('preserves a hand-written section below the generated list', async () => {
    await withTmpCopy('index-splice-below', async (lat) => {
      const errors = await checkIndex(lat, { fix: true });
      expect(errors).toHaveLength(0);

      const content = await readFile(join(lat, 'sub', 'sub.md'), 'utf-8');
      expect(content).toContain('## Hand-written notes');
      expect(content).toContain(
        'IMPORTANT: this section was written by a person and must survive --fix.',
      );
    });
  });
});

describe('index-splice-above', () => {
  // @lat: [[check-index#Splicing preserves hand-written content#Hand-written content above the generated list survives]]
  it('preserves a hand-written section above the generated list', async () => {
    await withTmpCopy('index-splice-above', async (lat) => {
      const errors = await checkIndex(lat, { fix: true });
      expect(errors).toHaveLength(0);

      const content = await readFile(join(lat, 'sub', 'sub.md'), 'utf-8');
      expect(content).toContain('## Preamble notes');
      expect(content).toContain(
        'Hand-written preamble that must survive above the generated list.',
      );
    });
  });
});

describe('index-splice-external-link', () => {
  // @lat: [[check-index#Splicing preserves hand-written content#A hand-written external-link bullet survives untouched]]
  it('preserves a hand-written external-link bullet and the prose after it', async () => {
    await withTmpCopy('index-splice-external-link', async (lat) => {
      const errors = await checkIndex(lat, { fix: true });
      expect(errors).toHaveLength(0);

      const content = await readFile(join(lat, 'sub', 'sub.md'), 'utf-8');
      expect(content).toContain(
        '- [External docs](https://example.com/docs) — hand-written external reference',
      );
      expect(content).toContain('## Hand-written notes');
      expect(content).toContain(
        'More hand-written prose below the external link bullet.',
      );
    });
  });
});

describe('index-splice-idempotent', () => {
  // @lat: [[check-index#Splicing preserves hand-written content#Running --fix twice is byte-identical]]
  it('produces byte-identical output on a second --fix run', async () => {
    await withTmpCopy('index-splice-idempotent', async (lat) => {
      await checkIndex(lat, { fix: true });
      const first = await readFile(join(lat, 'sub', 'sub.md'), 'utf-8');

      await checkIndex(lat, { fix: true });
      const second = await readFile(join(lat, 'sub', 'sub.md'), 'utf-8');

      expect(second).toBe(first);
      expect(
        (first.match(/<!-- lat:index:begin -->/g) ?? []).length,
      ).toBe(1);
      expect((first.match(/<!-- lat:index:end -->/g) ?? []).length).toBe(1);
      expect(first).toContain(
        'Prose that must survive both the first and second --fix run.',
      );
    });
  });
});

describe('index-splice-malformed-markers', () => {
  // @lat: [[check-index#Splicing preserves hand-written content#A malformed marker pair is refused and the file is left unchanged]]
  it('refuses to fix a file with an unmatched begin marker, leaving it unchanged', async () => {
    await withTmpCopy('index-splice-malformed-markers', async (lat) => {
      const before = await readFile(join(lat, 'sub', 'sub.md'), 'utf-8');

      const errors = await checkIndex(lat, { fix: true });
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some((e) => /marker/i.test(e.message))).toBe(true);

      const after = await readFile(join(lat, 'sub', 'sub.md'), 'utf-8');
      expect(after).toBe(before);
    });
  });
});
