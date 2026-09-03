import { describe, it, expect, vi } from 'vitest';
import { join } from 'node:path';

// Count real tree walks. Upstream absorbed lat-t1y.23's explicit
// preloaded-sections parameter into a session memoised on the command context,
// so the property under test is unchanged but the seam moved: what proves one
// parse per prompt is now that every caller shares one `ctx`.
vi.mock('../src/walk.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/walk.js')>();
  return { ...actual, walkEntries: vi.fn(actual.walkEntries) };
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
  searchSections: vi.fn(async () => []),
}));

const clean = join(import.meta.dirname, 'cases', 'hook-clean');
const latDir = join(clean, 'lat.md');

function makeCtx() {
  return {
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
}

describe('parses the lat.md tree once per prompt (lat-t1y.23)', () => {
  // @lat: [[hook#Parses the lat.md tree once per prompt (lat-t1y.23)#expandPrompt reuses the analysis memoised on its context]]
  it('expandPrompt reuses the analysis memoised on its context', async () => {
    const { walkEntries } = await import('../src/walk.js');
    const { expandPrompt } = await import('../src/cli/expand.js');
    const { commandProjectAnalysis } = await import(
      '../src/project-analysis.js'
    );
    const spy = vi.mocked(walkEntries);

    const ctx = makeCtx();
    spy.mockClear();
    const first = await expandPrompt(ctx, '[[feature]]');
    expect(first).not.toBeNull();
    const walksAfterFirst = spy.mock.calls.length;
    expect(walksAfterFirst).toBeGreaterThan(0);

    // Same ctx: the analysis is already on it, so nothing is walked again and
    // the output is byte-identical.
    const second = await expandPrompt(ctx, '[[feature]]');
    expect(spy.mock.calls.length).toBe(walksAfterFirst);
    expect(second).toBe(first);

    // And it is the very same analysis object, not an equal copy.
    expect(await commandProjectAnalysis(ctx)).toBe(
      await commandProjectAnalysis(ctx),
    );

    // A fresh ctx is a fresh session, so the cache is per-command and not global.
    const other = makeCtx();
    spy.mockClear();
    await expandPrompt(other, '[[feature]]');
    expect(spy.mock.calls.length).toBeGreaterThan(0);
  });

  // @lat: [[hook#Parses the lat.md tree once per prompt (lat-t1y.23)#runSearch resolves matches from a supplied analysis without re-parsing the tree]]
  it('runSearch resolves matches from a supplied analysis without re-parsing the tree', async () => {
    const { walkEntries } = await import('../src/walk.js');
    const { runSearch } = await import('../src/cli/search.js');
    const { commandProjectAnalysis } = await import(
      '../src/project-analysis.js'
    );
    const spy = vi.mocked(walkEntries);

    const ctx = makeCtx();
    const project = await commandProjectAnalysis(ctx);
    const featureId = [...project.sectionById.keys()].find((id) =>
      id.includes('feature'),
    )!;
    expect(featureId).toBeDefined();
    vi.mocked(
      (await import('../src/search/search.js')).searchSections,
    ).mockResolvedValue([
      { id: featureId, file: '', heading: '', content: '', score: 1 },
    ]);

    // The hook hands runSearch the analysis it already has; nothing is re-walked.
    spy.mockClear();
    const supplied = await runSearch(latDir, 'feature', 5, undefined, {
      buildIndex: false,
      project,
    });
    expect(spy).not.toHaveBeenCalled();
    expect(supplied.matches).toHaveLength(1);
    expect(supplied.matches[0].section.id.toLowerCase()).toBe(featureId);

    // Supplying nothing is unchanged: runSearch analyses the tree itself and
    // resolves the same match.
    spy.mockClear();
    const unsupplied = await runSearch(latDir, 'feature', 5, undefined, {
      buildIndex: false,
    });
    expect(spy.mock.calls.length).toBeGreaterThan(0);
    expect(unsupplied.matches).toEqual(supplied.matches);
  });
});
