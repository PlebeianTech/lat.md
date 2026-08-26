import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { checkIndex } from '../src/cli/check.js';
import { fencedLineMask } from '../src/cli/gen-index.js';

const casesDir = join(import.meta.dirname, 'cases');

function latDir(name: string): string {
  return join(casesDir, name, 'lat.md');
}

// lat-t1y.40: parseIndexEntries must not read a fenced-example bullet as a
// real index entry. It reuses gen-index.ts's fencedLineMask so the read
// side and the write side (spliceIndexContent, lat-t1y.32) agree on what
// counts as fenced.

describe('index-fenced-example', () => {
  it('does not flag a bullet shown inside a fenced code example', async () => {
    const errors = await checkIndex(latDir('index-fenced-example'));
    expect(errors).toHaveLength(0);
  });
});

describe('index-fenced-real-stale', () => {
  it('still validates a real entry that sits outside the fence', async () => {
    const errors = await checkIndex(latDir('index-fenced-real-stale'));
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('"[[gone]]"');
    expect(errors[0].message).toContain('does not exist');
  });
});

describe('index-fenced-tilde', () => {
  it('treats a tilde fence the same as a backtick fence', async () => {
    const errors = await checkIndex(latDir('index-fenced-tilde'));
    expect(errors).toHaveLength(0);
  });
});

describe('index-fenced-longfence', () => {
  it('treats a four-backtick fence the same as a three-backtick fence', async () => {
    const errors = await checkIndex(latDir('index-fenced-longfence'));
    expect(errors).toHaveLength(0);
  });
});

describe('index-fenced-unterminated', () => {
  // Known conflict with the "no swallow" acceptance criterion — see the
  // lat-t1y.40 handoff report. fencedLineMask itself is out of scope here.
  // The mask stays "inside the fence" through EOF once unclosed, so the
  // real `[[notes]]` entry after it is swallowed too and reported missing,
  // rather than the `[[gone]]` stale entry being flagged as expected.
  it('documents that an unterminated fence masks the rest of the document', async () => {
    const errors = await checkIndex(latDir('index-fenced-unterminated'));
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('missing entries');
    expect(errors[0].message).toContain('[[notes]]');
  });
});

describe('fencedLineMask / parseIndexEntries agreement', () => {
  it('never derives an entry from a line the mask marks as fenced', async () => {
    const content = [
      'Project index.',
      '',
      '```markdown',
      '- [Example](example.md) - an entry that does not exist',
      '- [[also-fake]] — not real either',
      '```',
      '',
      '<!-- lat:index:begin -->',
      '- [[notes]] — Notes overview.',
      '<!-- lat:index:end -->',
    ];
    const mask = fencedLineMask(content);

    // The two fenced example bullets must be masked...
    expect(mask[3]).toBe(true);
    expect(mask[4]).toBe(true);
    // ...and the real entry must not be.
    expect(mask[8]).toBe(false);

    const errors = await checkIndex(latDir('index-fenced-example'));
    expect(errors).toHaveLength(0);
  });
});
