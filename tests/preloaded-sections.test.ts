import { describe, it, expect, vi } from 'vitest';
import { join } from 'node:path';

// Spy on loadAllSections while keeping its real implementation, so the tests
// below can count how many times the tree is actually walked and parsed —
// the seam lat-t1y.23 threads a pre-loaded-sections parameter through.
vi.mock('../src/lattice.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lattice.js')>();
  return { ...actual, loadAllSections: vi.fn(actual.loadAllSections) };
});

vi.mock('../src/search/db.js', () => ({
  openDb: vi.fn(() => ({})),
  ensureMeta: vi.fn(async () => {}),
  getStoredModel: vi.fn(async () => 'fake-model'),
  ensureSectionsSchema: vi.fn(async () => {}),
  closeDb: vi.fn(async () => {}),
}));

vi.mock('../src/search/embedder.js', () => ({
  embedderForIndex: vi.fn(async () => ({ dimensions: 3, name: 'local:fake' })),
}));

vi.mock('../src/search/search.js', () => ({
  searchSections: vi.fn(async () => [
    { id: 'feature', file: '', heading: '', content: '' },
  ]),
}));

const clean = join(import.meta.dirname, 'cases', 'hook-clean');

describe('parses the lat.md tree once per prompt (lat-t1y.23)', () => {
  // @lat: [[hook#Parses the lat.md tree once per prompt (lat-t1y.23)#expandPrompt uses preloaded sections instead of re-parsing the tree]]
  it('expandPrompt uses preloaded sections instead of re-parsing the tree', async () => {
    const { loadAllSections } = await import('../src/lattice.js');
    const { expandPrompt } = await import('../src/cli/expand.js');
    const spy = vi.mocked(loadAllSections);
    spy.mockClear();

    const latDir = join(clean, 'lat.md');
    const ctx = {
      latDir,
      projectRoot: clean,
      styler: {
        bold: (s: string) => s,
        dim: (s: string) => s,
        red: (s: string) => s,
        cyan: (s: string) => s,
        white: (s: string) => s,
        green: (s: string) => s,
        yellow: (s: string) => s,
        boldWhite: (s: string) => s,
      },
      mode: 'cli' as const,
    };

    // Baseline: no preloaded sections still works, and still walks the tree.
    const withoutPreload = await expandPrompt(ctx, '[[feature]]');
    expect(withoutPreload).not.toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);

    // With preloaded sections, the tree is not walked again.
    spy.mockClear();
    const preloaded = await spy.getMockImplementation()!(latDir);
    const withPreload = await expandPrompt(ctx, '[[feature]]', preloaded);
    expect(spy).not.toHaveBeenCalled();

    // Results are byte-identical whether or not sections were preloaded.
    expect(withPreload).toBe(withoutPreload);
  });

  // @lat: [[hook#Parses the lat.md tree once per prompt (lat-t1y.23)#runSearch resolves matches from preloaded sections without re-parsing the tree]]
  it('runSearch resolves matches from preloaded sections without re-parsing the tree', async () => {
    const { loadAllSections, flattenSections } =
      await import('../src/lattice.js');
    const { runSearch } = await import('../src/cli/search.js');
    const spy = vi.mocked(loadAllSections);

    const latDir = join(clean, 'lat.md');
    const preloaded = await spy.getMockImplementation()!(latDir);
    const featureId = flattenSections(preloaded).find((s) =>
      s.filePath.endsWith('feature.md'),
    )!.id;
    vi.mocked(
      (await import('../src/search/search.js')).searchSections,
    ).mockResolvedValue([
      { id: featureId, file: '', heading: '', content: '' },
    ]);

    spy.mockClear();
    const withPreload = await runSearch(latDir, 'feature', 5, undefined, {
      buildIndex: false,
      preloadedSections: preloaded,
    });
    expect(spy).not.toHaveBeenCalled();
    expect(withPreload.matches).toHaveLength(1);
    expect(withPreload.matches[0].section.id).toBe(featureId);

    // Passing no preloaded sections is unchanged: it still resolves the
    // match by walking the tree itself.
    spy.mockClear();
    const withoutPreload = await runSearch(latDir, 'feature', 5, undefined, {
      buildIndex: false,
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(withoutPreload.matches).toEqual(withPreload.matches);
  });
});
