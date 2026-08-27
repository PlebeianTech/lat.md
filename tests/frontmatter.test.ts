import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { parseFrontmatter, LAT_FIELDS } from '../src/lattice.js';

describe('parseFrontmatter', () => {
  it('sets requireCodeMention when lat.require-code-mention is true', () => {
    const fm = parseFrontmatter(
      '---\nlat:\n  require-code-mention: true\n---\n\n# Doc\n',
    );
    expect(fm.requireCodeMention).toBe(true);
  });

  it('leaves requireCodeMention undefined for a bare top-level require-code-mention (no lat: wrapper)', () => {
    const fm = parseFrontmatter(
      '---\nrequire-code-mention: true\n---\n\n# Doc\n',
    );
    expect(fm.requireCodeMention).toBeUndefined();
  });

  it('leaves requireCodeMention undefined when the value is not boolean true', () => {
    const fm = parseFrontmatter(
      '---\nlat:\n  require-code-mention: false\n---\n\n# Doc\n',
    );
    expect(fm.requireCodeMention).toBeUndefined();
  });

  it('keeps unknown keys under lat: in raw', () => {
    const fm = parseFrontmatter(
      '---\nlat:\n  mode: strict\n  owner: alice\n---\n\n# Doc\n',
    );
    expect(fm.raw).toEqual({ mode: 'strict', owner: 'alice' });
  });

  it('parses nested structured values under lat: into raw', () => {
    const fm = parseFrontmatter(
      '---\nlat:\n  tags:\n    - a\n    - b\n  meta:\n    count: 2\n---\n\n# Doc\n',
    );
    expect(fm.raw).toEqual({ tags: ['a', 'b'], meta: { count: 2 } });
  });

  it('returns { raw: {} } for malformed YAML without throwing', () => {
    expect(() =>
      parseFrontmatter('---\nfoo: [unterminated\n---\n\n# Doc\n'),
    ).not.toThrow();
    const fm = parseFrontmatter('---\nfoo: [unterminated\n---\n\n# Doc\n');
    expect(fm.raw).toEqual({});
  });

  it('returns { raw: {} } when there is no frontmatter block', () => {
    const fm = parseFrontmatter('# Doc\n\nJust content.\n');
    expect(fm.raw).toEqual({});
  });

  it('returns { raw: {} } when the block is a top-level scalar', () => {
    const fm = parseFrontmatter('---\njust a string\n---\n\n# Doc\n');
    expect(fm.raw).toEqual({});
  });

  it('returns { raw: {} } when the block is a top-level array', () => {
    const fm = parseFrontmatter('---\n- one\n- two\n---\n\n# Doc\n');
    expect(fm.raw).toEqual({});
  });
});

// A field written at the document root was accepted by the regex reader that
// lat-t1y.1 replaced. It now stops being read, and because the field it most
// often carries turns a validation ON, the failure is silent and fails open.
describe('frontmatter field placement', () => {
  // @lat: [[frontmatter-placement#parseFrontmatter reports misplaced fields#Reports a known lat field written at the document root]]
  it('reports a known lat field written at the document root', () => {
    const fm = parseFrontmatter(
      '---\nrequire-code-mention: true\n---\n\n# T\n',
    );
    expect(fm.problems).toEqual([
      { kind: 'root-level-field', field: 'require-code-mention' },
    ]);
    expect(fm.requireCodeMention).toBeUndefined();
  });

  // @lat: [[frontmatter-placement#parseFrontmatter reports misplaced fields#Reports nothing when the field is nested under lat]]
  it('reports nothing when the same field is nested under lat', () => {
    const fm = parseFrontmatter(
      '---\nlat:\n  require-code-mention: true\n---\n\n# T\n',
    );
    expect(fm.problems).toBeUndefined();
    expect(fm.requireCodeMention).toBe(true);
  });

  // @lat: [[frontmatter-placement#parseFrontmatter reports misplaced fields#Reports nothing for a root key that is not a lat field]]
  it('reports nothing for a root key that is not a lat field', () => {
    expect(
      parseFrontmatter('---\nowner: platform-team\n---\n\n# T\n').problems,
    ).toBeUndefined();
  });

  // @lat: [[frontmatter-placement#parseFrontmatter reports misplaced fields#Reports nothing for a document with no frontmatter]]
  it('reports nothing for a document with no frontmatter', () => {
    expect(parseFrontmatter('# T\n\nBody.\n').problems).toBeUndefined();
  });

  // @lat: [[frontmatter-placement#parseFrontmatter reports misplaced fields#Covers every known field, not just one]]
  it('covers every field in the known-field list, not just one', () => {
    for (const field of LAT_FIELDS) {
      const fm = parseFrontmatter(`---\n${field}: x\n---\n\n# T\n`);
      expect(fm.problems, field).toEqual([{ kind: 'root-level-field', field }]);
    }
  });

  // Losing the whole block to one bad line is the same failure by another
  // route: every lat field in the document silently stops being read.
  // @lat: [[frontmatter-placement#parseFrontmatter reports malformed YAML#Reports frontmatter that is not valid YAML instead of swallowing it]]
  it('reports frontmatter that is not valid YAML instead of swallowing it', () => {
    const fm = parseFrontmatter(
      '---\nlat:\n  require-code-mention: true\nowner: a: b\n---\n\n# T\n',
    );
    expect(fm.problems?.[0].kind).toBe('parse-error');
    expect(fm.requireCodeMention).toBeUndefined();
  });
});

describe('checkFrontmatter over fixture trees', () => {
  const casesDir = join(import.meta.dirname, 'cases');
  const lat = (n: string) => join(casesDir, n, 'lat.md');

  // @lat: [[frontmatter-placement#checkFrontmatter over fixture trees#Names the field and shows the nested form as the fix]]
  it('names the field and shows the nested form as the fix', async () => {
    const { checkFrontmatter } =
      await import('../src/cli/check-frontmatter.js');
    const errors = await checkFrontmatter(lat('frontmatter-root-misplaced'));
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('require-code-mention');
    expect(errors[0].message).toContain('lat:');
  });

  // @lat: [[frontmatter-placement#checkFrontmatter over fixture trees#Passes the nested form and an unrelated root key]]
  it('passes the nested form and an unrelated root key', async () => {
    const { checkFrontmatter } =
      await import('../src/cli/check-frontmatter.js');
    expect(await checkFrontmatter(lat('frontmatter-root-nested'))).toEqual([]);
    expect(await checkFrontmatter(lat('frontmatter-root-unknown-key'))).toEqual(
      [],
    );
  });

  // @lat: [[frontmatter-placement#checkFrontmatter over fixture trees#Reports a malformed block rather than losing the field in silence]]
  it('reports a malformed block rather than losing the field in silence', async () => {
    const { checkFrontmatter } =
      await import('../src/cli/check-frontmatter.js');
    const errors = await checkFrontmatter(lat('frontmatter-root-malformed'));
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('not valid YAML');
  });
});
