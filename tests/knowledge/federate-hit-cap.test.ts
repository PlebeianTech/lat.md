import { describe, expect, it } from 'vitest';
import { federateTags } from '../../src/knowledge/index.js';
import type {
  KnowledgeHit,
  Store,
  StoreName,
  TaggedDoc,
} from '../../src/knowledge/types.js';

const storeNames: StoreName[] = ['cq', 'bd', 'claude-memory'];

function fakeStore(name: StoreName): Store {
  return {
    name,
    async query(): Promise<KnowledgeHit[]> {
      return [1, 2, 3].map((n) => ({
        store: name,
        key: `${name}-${n}`,
        title: `${name} hit ${n}`,
        detail: 'detail',
        score: 10 - n,
      }));
    },
  };
}

const stores = storeNames.map(fakeStore);
const docs: TaggedDoc[] = ['a.md', 'b.md', 'c.md'].map((id) => ({
  id,
  tags: ['alpha'],
}));

function hitLines(output: string | null): string[] {
  return (output ?? '').split('\n').filter((line) => line.startsWith('- '));
}

describe('federateTags total hit cap', () => {
  // @lat: [[fork-federate-hit-cap#Default cap keeps nine hits in document order]]
  it('keeps nine hits and earlier documents keep theirs first', async () => {
    const output = await federateTags(docs, {
      projectRoot: '/tmp',
      stores,
    });
    expect(hitLines(output)).toHaveLength(9);
    expect(output).toContain('a.md (alpha):');
    expect(output).not.toContain('b.md');
    expect(output).not.toContain('c.md');
  });

  // @lat: [[fork-federate-hit-cap#A fully cut document is neither emitted nor seen]]
  it('neither emits nor marks seen a document with all hits cut', async () => {
    const seen = new Set<string>();
    const output = await federateTags(docs, {
      projectRoot: '/tmp',
      stores,
      maxTotalHits: 12,
      seen,
    });
    expect(hitLines(output)).toHaveLength(12);
    expect(output!.indexOf('a.md')).toBeLessThan(output!.indexOf('b.md'));
    expect(output).not.toContain('c.md');
    expect([...seen]).toEqual(['a.md', 'b.md']);
  });

  // @lat: [[fork-federate-hit-cap#Below the cap output is unchanged]]
  it('leaves output unchanged below the cap', async () => {
    const output = await federateTags([docs[0]], {
      projectRoot: '/tmp',
      stores,
    });
    const group = (name: string, label: string) =>
      [label, ...[1, 2, 3].map((n) => `- "${name} hit ${n}" -> "detail"`)].join(
        '\n',
      );
    expect(output!.split('\n').slice(3).join('\n')).toBe(
      [
        'a.md (alpha):',
        group('cq', 'cq:'),
        group('bd', 'bd memories:'),
        group('claude-memory', 'Claude Code memory:'),
      ].join('\n'),
    );
  });

  // @lat: [[fork-federate-hit-cap#An explicit cap overrides the default]]
  it('lets maxTotalHits override the default', async () => {
    const small = await federateTags(docs, {
      projectRoot: '/tmp',
      stores,
      maxTotalHits: 4,
    });
    expect(hitLines(small)).toHaveLength(4);
    const large = await federateTags(docs, {
      projectRoot: '/tmp',
      stores,
      maxTotalHits: 20,
    });
    expect(hitLines(large)).toHaveLength(20);
  });
});
