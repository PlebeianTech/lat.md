import { describe, it, expect, vi, beforeEach } from 'vitest';
import { join } from 'node:path';
import {
  plainStyler,
  type CmdContext,
} from '@plebeiantech/lat.md-core/context';
import type {
  Section,
  SectionMatch,
} from '@plebeiantech/lat.md-core/lattice-model';
import {
  PROMPT_SEARCH_MAX_BYTES,
  formatCompactSearchMatch,
  formatPromptSearchMatches,
} from '../src/cli/fork-prompt-search.js';
import { commandProjectAnalysis } from '@plebeiantech/lat.md-core/project-analysis';

const { getSectionSpy } = vi.hoisted(() => ({
  getSectionSpy: vi.fn(),
}));

vi.mock('@plebeiantech/lat.md-core/cli/section', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@plebeiantech/lat.md-core/cli/section')
    >();
  getSectionSpy.mockImplementation(actual.getSection);
  return {
    ...actual,
    getSection: getSectionSpy,
  };
});

function makeContext(overrides?: Partial<CmdContext>): CmdContext {
  return {
    latDir: join(process.cwd(), 'lat.md'),
    projectRoot: process.cwd(),
    styler: plainStyler,
    mode: 'cli',
    ...overrides,
  };
}

function makeSection(overrides?: Partial<Section>): Section {
  return {
    id: 'cli#CLI#hook#UserPromptSubmit',
    heading: 'UserPromptSubmit',
    depth: 3,
    file: 'cli.md',
    filePath: 'lat.md/cli.md',
    children: [],
    startLine: 120,
    endLine: 180,
    firstParagraph:
      'Prompt hooks provide agent context before execution begins.',
    ...overrides,
  };
}

function makeMatch(section: Section, reason = 'exact match'): SectionMatch {
  return {
    section,
    reason,
    rankScore: 0.98,
  };
}

describe('fork prompt search context formatting', () => {
  let ctx: CmdContext;

  beforeEach(() => {
    ctx = makeContext();
    getSectionSpy.mockClear();
  });

  // @lat: [[fork-prompt-search#Fork Prompt Search#Empty matches return null]]
  it('returns null when matches array is empty', async () => {
    const result = await formatPromptSearchMatches(ctx, []);
    expect(result).toBeNull();
    expect(getSectionSpy).not.toHaveBeenCalled();
  });

  // @lat: [[fork-prompt-search#Fork Prompt Search#Single match within budget renders full section output]]
  it('renders full section output with header when exactly 1 match fits within budget', async () => {
    const section = makeSection({ id: 'guide#Intro' });
    const match = makeMatch(section);

    getSectionSpy.mockResolvedValueOnce({
      kind: 'found',
      section,
      content: '## Intro\n\nFull section body text for testing.',
      status: null,
      outgoingRefs: [],
      outgoingSourceRefs: [],
      outgoingExternalRefs: [],
      incomingRefs: [],
      codeRefs: [],
    });

    const result = await formatPromptSearchMatches(ctx, [match], 2500);

    expect(result).not.toBeNull();
    expect(result).toContain('Search results for the user prompt (1 matches):');
    expect(result).toContain('> ## Intro');
    expect(result).toContain('Full section body text for testing.');
    expect(result).not.toContain('Run lat section');
    expect(getSectionSpy).toHaveBeenCalledTimes(1);
    expect(getSectionSpy).toHaveBeenCalledWith(ctx, 'guide#Intro');
    expect(Buffer.byteLength(result!, 'utf-8')).toBeLessThanOrEqual(2500);
  });

  // @lat: [[fork-prompt-search#Fork Prompt Search#Single match exceeding budget falls back to compact preview]]
  it('falls back to compact preview when single match full output exceeds maxBytes', async () => {
    const section = makeSection({
      id: 'guide#Massive',
      firstParagraph: 'A massive section overview.',
    });
    const match = makeMatch(section);

    getSectionSpy.mockResolvedValueOnce({
      kind: 'found',
      section,
      content: 'Massive content\n'.repeat(300),
      status: null,
      outgoingRefs: [],
      outgoingSourceRefs: [],
      outgoingExternalRefs: [],
      incomingRefs: [],
      codeRefs: [],
    });

    const result = await formatPromptSearchMatches(ctx, [match], 2500);

    expect(result).not.toBeNull();
    expect(result).toContain('Search results for the user prompt (1 matches):');
    expect(result).toContain('* [[guide#Massive]]');
    expect(result).toContain('A massive section overview.');
    expect(result).toContain(
      'Run lat section "section#id" to read the full content of a matching section.',
    );
    expect(result).not.toContain('Massive content');
    expect(getSectionSpy).toHaveBeenCalledTimes(1);
    expect(Buffer.byteLength(result!, 'utf-8')).toBeLessThanOrEqual(2500);
  });

  // @lat: [[fork-prompt-search#Fork Prompt Search#Single match with unresolvable section falls back to compact preview]]
  it('falls back to compact preview when single match getSection returns no-match', async () => {
    const section = makeSection({
      id: 'missing#Section',
      firstParagraph: 'Description of unresolvable section.',
    });
    const match = makeMatch(section);

    getSectionSpy.mockResolvedValueOnce({
      kind: 'no-match',
      suggestions: [],
    });

    const result = await formatPromptSearchMatches(ctx, [match], 2500);

    expect(result).not.toBeNull();
    expect(result).toContain('Search results for the user prompt (1 matches):');
    expect(result).toContain('* [[missing#Section]]');
    expect(result).toContain('Description of unresolvable section.');
    expect(result).toContain(
      'Run lat section "section#id" to read the full content of a matching section.',
    );
  });

  // @lat: [[fork-prompt-search#Fork Prompt Search#Multiple matches produce compact previews without loading full sections]]
  it('renders compact previews for multiple matches and never calls getSection', async () => {
    const matches: SectionMatch[] = [
      makeMatch(
        makeSection({
          id: 'auth#Login',
          filePath: 'lat.md/auth.md',
          startLine: 1,
          endLine: 20,
          firstParagraph: 'Handles user login.',
        }),
      ),
      makeMatch(
        makeSection({
          id: 'auth#Tokens',
          filePath: 'lat.md/auth.md',
          startLine: 21,
          endLine: 40,
          firstParagraph: 'Handles token refresh.',
        }),
      ),
      makeMatch(
        makeSection({
          id: 'auth#Logout',
          filePath: 'lat.md/auth.md',
          startLine: 41,
          endLine: 60,
          firstParagraph: 'Handles user logout.',
        }),
      ),
    ];

    const result = await formatPromptSearchMatches(ctx, matches);

    expect(result).not.toBeNull();
    expect(result).toContain('Search results for the user prompt (3 matches):');
    expect(result).toContain(
      '* [[auth#Login]] (lat.md/auth.md:1-20) - Handles user login.',
    );
    expect(result).toContain(
      '* [[auth#Tokens]] (lat.md/auth.md:21-40) - Handles token refresh.',
    );
    expect(result).toContain(
      '* [[auth#Logout]] (lat.md/auth.md:41-60) - Handles user logout.',
    );
    expect(result).toContain(
      'Run lat section "section#id" to read the full content of a matching section.',
    );
    expect(getSectionSpy).not.toHaveBeenCalled();
    expect(Buffer.byteLength(result!, 'utf-8')).toBeLessThanOrEqual(
      PROMPT_SEARCH_MAX_BYTES,
    );
  });

  // @lat: [[fork-prompt-search#Fork Prompt Search#Output strictly honors maximum byte limit]]
  it('guarantees output never exceeds byte limit under varying thresholds', async () => {
    const matches = Array.from({ length: 15 }, (_, i) =>
      makeMatch(
        makeSection({
          id: `module#Feature${i}`,
          filePath: `lat.md/feature${i}.md`,
          startLine: 10 * i,
          endLine: 10 * i + 20,
          firstParagraph: `Detailed paragraph describing feature ${i} with substantial length to stress byte allocation.`,
        }),
      ),
    );

    const limits = [512, 768, 1024, 1500, 2500];
    for (const maxBytes of limits) {
      const result = await formatPromptSearchMatches(ctx, matches, maxBytes);
      expect(result).not.toBeNull();
      const bytes = Buffer.byteLength(result!, 'utf-8');
      expect(bytes).toBeLessThanOrEqual(maxBytes);
      expect(bytes).toBeGreaterThan(0);
      expect(result).toContain(
        'Search results for the user prompt (15 matches):',
      );
      expect(result).toContain(
        'Run lat section "section#id" to read the full content of a matching section.',
      );
    }
  });

  // @lat: [[fork-prompt-search#Fork Prompt Search#Truncation preserves trailing navigation hint]]
  it('drops trailing matches when budget is exhausted while preserving the navigation hint', async () => {
    const matches = Array.from({ length: 6 }, (_, i) =>
      makeMatch(
        makeSection({
          id: `item#Entry${i}`,
          firstParagraph: `Item paragraph content for item ${i}.`,
        }),
      ),
    );

    const tightBudget = 550;
    const result = await formatPromptSearchMatches(ctx, matches, tightBudget);

    expect(result).not.toBeNull();
    expect(Buffer.byteLength(result!, 'utf-8')).toBeLessThanOrEqual(
      tightBudget,
    );
    expect(result).toContain('* [[item#Entry0]]');
    expect(result).toContain('* [[item#Entry1]]');
    expect(result).not.toContain('* [[item#Entry5]]');
    expect(
      result!.endsWith(
        'Run lat section "section#id" to read the full content of a matching section.',
      ),
    ).toBe(true);
  });

  // @lat: [[fork-prompt-search#Fork Prompt Search#Multi-byte UTF-8 characters are measured by byte length]]
  it('measures multi-byte UTF-8 characters by byte count rather than character length', async () => {
    const multiByteSummary = '🚀📦⚙️ 日本語の概要説明テキスト café';
    const section = makeSection({
      id: 'unicode#Section',
      firstParagraph: multiByteSummary,
    });
    const match = makeMatch(section);

    expect(Buffer.byteLength(multiByteSummary, 'utf-8')).toBeGreaterThan(
      multiByteSummary.length,
    );

    const result = await formatPromptSearchMatches(ctx, [match, match], 512);

    expect(result).not.toBeNull();
    expect(Buffer.byteLength(result!, 'utf-8')).toBeLessThanOrEqual(512);
    expect(result).toContain('🚀📦⚙️');
    expect(result).toContain('日本語の概要説明テキスト');
  });

  // @lat: [[fork-prompt-search#Fork Prompt Search#Compact match formatter formats bullets and sanitizes paths]]
  it('formats compact bullets with normalized POSIX paths and omitted empty summaries', () => {
    const standardSection = makeSection({
      id: 'guide#Start',
      filePath: 'lat.md/guide/start.md',
      startLine: 15,
      endLine: 45,
      firstParagraph: 'Quick start instructions.',
    });
    const formatted = formatCompactSearchMatch(ctx, standardSection);
    expect(formatted).toBe(
      '* [[guide#Start]] (lat.md/guide/start.md:15-45) - Quick start instructions.',
    );

    const emptySummarySection = makeSection({
      id: 'guide#Empty',
      filePath: 'lat.md/guide/empty.md',
      startLine: 1,
      endLine: 10,
      firstParagraph: '',
    });
    const formattedEmpty = formatCompactSearchMatch(ctx, emptySummarySection);
    expect(formattedEmpty).toBe(
      '* [[guide#Empty]] (lat.md/guide/empty.md:1-10)',
    );
  });

  // @lat: [[fork-prompt-search#Fork Prompt Search#Untrusted identifiers and text are sanitized]]
  it('sanitizes untrusted section IDs, paths, and paragraphs', () => {
    const maliciousSection = makeSection({
      id: 'guide#Topic]] <script>alert(1)</script> | alias [breakout]',
      filePath: 'lat.md/bad\x00path\u202Ereversed.md',
      startLine: 1,
      endLine: 10,
      firstParagraph: 'Normal text ' + 'a'.repeat(350),
    });

    const bullet = formatCompactSearchMatch(ctx, maliciousSection);

    expect(bullet).not.toContain('Topic]]');
    expect(bullet).not.toContain('<script>');
    expect(bullet).toContain(
      '[[guide#Topic)) (script)alert(1)(/script) / alias (breakout)]]',
    );

    expect(bullet).not.toContain('\x00');
    expect(bullet).not.toContain('\u202E');

    expect(bullet).toContain('…');
    expect(bullet.length).toBeLessThan(450);
  });

  // @lat: [[fork-prompt-search#Fork Prompt Search#Hook integration delegates UserPromptSubmit to budgeted search]]
  it('integrates with commandProjectAnalysis against real project fixtures', async () => {
    const fixtureRoot = join(import.meta.dirname, 'cases', 'hook-clean');
    const fixtureCtx: CmdContext = {
      latDir: join(fixtureRoot, 'lat.md'),
      projectRoot: fixtureRoot,
      styler: plainStyler,
      mode: 'cli',
    };

    const project = await commandProjectAnalysis(fixtureCtx);
    const matches: SectionMatch[] = project.allSections
      .slice(0, 2)
      .map((s) => ({
        section: s,
        reason: 'fixture match',
      }));

    const result = await formatPromptSearchMatches(fixtureCtx, matches, 2500);

    expect(result).not.toBeNull();
    expect(result).toContain('Search results for the user prompt (2 matches):');
    expect(result).toContain(
      'Run lat section "section#id" to read the full content of a matching section.',
    );
    expect(Buffer.byteLength(result!, 'utf-8')).toBeLessThanOrEqual(2500);
  });
});
