import { readFile } from 'node:fs/promises';
import { LEXICAL_VERSION } from '../search/lexical.js';
import { hasIndex } from '../search/db.js';
import { embeddingFingerprint } from '../search/chunks.js';
import { writeIndex } from '../search/cache.js';
import { dirname, join } from 'node:path';
import type { CmdContext, CmdResult, Styler } from '../context.js';
import {
  openDb,
  ensureMeta,
  getStoredModel,
  setStoredModel,
  ensureSectionsSchema,
  dropSections,
  closeDb,
} from '../search/db.js';
import { getLlmKey } from '../config.js';
import {
  embedderForIndex,
  modelKey,
  ReindexRequiredError,
  EmbeddingAuthError,
  type Embedder,
} from '../search/embedder.js';
import {
  indexSections,
  projectFingerprint,
  type IndexStats,
} from '../search/index.js';
import { searchSections } from '../search/search.js';
import type { SectionMatch } from '../lattice-model.js';
import type { Section } from '../lattice-model.js';
import {
  resolveSearchMatches,
  searchIndexedSections,
} from '../search/query.js';
import {
  analyzeMarkdownProject,
  commandProjectAnalysis,
  type MarkdownProjectAnalysis,
} from '../project-analysis.js';
import { formatSectionPreview, formatNavHints } from '../format.js';
import { provenanceNote, formatProvenanceNote } from './check-status.js';

export type SearchResult = {
  query: string;
  matches: SectionMatch[];
};

export type IndexProgress = {
  /** Called before indexing starts. `isEmpty` is true on first run. */
  beforeIndex?: (isEmpty: boolean) => void;
  /** Called after indexing completes with stats. */
  afterIndex?: (stats: IndexStats, isEmpty: boolean) => void;
};

async function withDb<T>(
  latDir: string,
  progress: IndexProgress | undefined,
  project: MarkdownProjectAnalysis,
  cacheDir: string | undefined,
  fn: (
    db: Awaited<ReturnType<typeof openDb>>,
    embedder: Embedder,
    project: MarkdownProjectAnalysis,
  ) => Promise<T>,
): Promise<T> {
  if (hasIndex(cacheDir ?? join(latDir, '.cache'))) {
    const db = openDb(latDir, cacheDir, true);
    try {
      const stored = await getStoredModel(db);
      const embedder = await embedderForIndex(stored, latDir);
      const metadata = new Map(
        (await db.execute('SELECT key,value FROM meta')).rows.map((row) => [
          row.key,
          row.value,
        ]),
      );
      if (metadata.get('fingerprint') !== embeddingFingerprint(embedder))
        throw new ReindexRequiredError(
          'Search chunking or embedding model changed; run lat reindex.',
        );
      if (
        stored &&
        metadata.get('lexical_version') === LEXICAL_VERSION &&
        metadata.get('project_hash') === projectFingerprint(project)
      ) {
        progress?.afterIndex?.(
          {
            added: 0,
            updated: 0,
            removed: 0,
            unchanged: project.sections.length,
          },
          false,
        );
        return await fn(db, embedder, project);
      }
    } finally {
      await closeDb(db);
    }
  }
  return writeIndex(latDir, cacheDir, false, async (db, stored) => {
    const embedder = await embedderForIndex(stored, latDir);
    await ensureSectionsSchema(db, embedder.dimensions);
    const isEmpty =
      (await db.execute('SELECT COUNT(*) AS n FROM sections')).rows[0].n === 0;
    progress?.beforeIndex?.(isEmpty);
    const stats = await indexSections(latDir, db, embedder, undefined, project);
    await setStoredModel(db, modelKey(embedder));
    progress?.afterIndex?.(stats, isEmpty);
    return fn(db, embedder, project);
  });
}

/**
 * Run a semantic search across lat.md sections.
 * Handles indexing (with optional progress callback). Returns matched sections.
 *
 * `opts.buildIndex: false` is read-only mode (the UserPromptSubmit hook): search
 * an existing index but never build or update it — so a user's first prompt in a
 * fresh repo isn't blocked by a full local embed pass. Building the index is
 * `lat search` / `lat reindex`. With nothing indexed yet, returns no matches
 * without even loading the embedder to embed the query.
 */
export async function runSearch(
  latDir: string,
  query: string,
  limit: number,
  progress?: IndexProgress,
  opts?: {
    buildIndex?: boolean;
    project?: MarkdownProjectAnalysis;
    sectionById?: ReadonlyMap<string, Section>;
    minSimilarity?: number;
    cacheDir?: string;
  },
): Promise<SearchResult> {
  if (opts?.buildIndex === false) {
    const sectionById =
      opts.sectionById ??
      opts.project?.sectionById ??
      (
        await analyzeMarkdownProject(latDir, dirname(latDir), {
          executor: 'auto',
        })
      ).sectionById;
    return searchIndexedSections(latDir, query, limit, sectionById, {
      cacheDir: opts.cacheDir,
      minSimilarity: opts.minSimilarity,
    });
  }

  const project =
    opts?.project ??
    (await analyzeMarkdownProject(latDir, dirname(latDir), {
      executor: 'auto',
    }));
  return withDb(
    latDir,
    progress,
    project,
    opts?.cacheDir,
    async (db, embedder, analyzed) => {
      const results = await searchSections(
        db,
        query,
        embedder,
        limit,
        opts?.minSimilarity,
      );
      return {
        query,
        matches: resolveSearchMatches(results, analyzed.sectionById),
      };
    },
  );
}

/**
 * Index-only mode (no query) — builds the index on first use. Rebuilding is
 * `lat reindex`, not a flag here.
 */
export async function runIndex(
  latDir: string,
  progress?: IndexProgress,
  analyzedProject?: MarkdownProjectAnalysis,
  options: { cacheDir?: string } = {},
): Promise<void> {
  const project =
    analyzedProject ??
    (await analyzeMarkdownProject(latDir, dirname(latDir), {
      executor: 'auto',
    }));
  await withDb(latDir, progress, project, options.cacheDir, async () => {});
}

export function cliProgress(s: Styler): IndexProgress {
  return {
    beforeIndex(isEmpty) {
      if (isEmpty) {
        process.stderr.write(s.dim('Building index...'));
      }
    },
    afterIndex(stats, isEmpty) {
      if (isEmpty) {
        process.stderr.write(
          s.dim(
            ` done (${stats.added} added, ${stats.updated} updated, ${stats.removed} removed)\n`,
          ),
        );
      } else if (stats.added + stats.updated + stats.removed > 0) {
        process.stderr.write(
          s.dim(
            `Index updated: ${stats.added} added, ${stats.updated} updated, ${stats.removed} removed\n`,
          ),
        );
      }
    },
  };
}

/**
 * Render search matches with each one's provenance.
 *
 * `formatResultList` in format.ts renders a bare list and is shared with
 * `lat locate` and `lat refs`. Search is the surface where an agent picks a
 * claim to act on without opening the document, so it is the one that has to
 * say whether a person ever checked that claim. Frontmatter is read once per
 * file rather than once per match, since several matches routinely share one.
 */
async function formatSearchMatches(
  ctx: CmdContext,
  query: string,
  matches: SectionMatch[],
  opts?: {
    showScores?: boolean;
    preview?: 'passage' | 'intro' | 'both';
  },
): Promise<string> {
  const notes = new Map<string, ReturnType<typeof provenanceNote>>();
  for (const match of matches) {
    const filePath = match.section.filePath;
    if (notes.has(filePath)) continue;
    try {
      const content = await readFile(join(ctx.projectRoot, filePath), 'utf-8');
      notes.set(filePath, provenanceNote(content));
    } catch {
      notes.set(filePath, null);
    }
  }

  const lines: string[] = ['', `## Search results for "${query}":`, ''];
  for (let i = 0; i < matches.length; i++) {
    if (i > 0) lines.push('');
    lines.push(
      formatSectionPreview(ctx, matches[i].section, {
        reason: matches[i].reason,
        spans:
          opts?.preview === 'intro'
            ? undefined
            : matches[i].evidence?.[0]?.spans,
        score: opts?.showScores ? matches[i].rankScore : undefined,
        text:
          opts?.preview === 'intro'
            ? undefined
            : matches[i].evidence?.length
              ? (opts?.preview === 'both'
                  ? matches[i].section.firstParagraph + '\n\n'
                  : '') + matches[i].evidence![0].text
              : undefined,
        debug:
          opts?.showScores && matches[i].rankScore !== undefined
            ? JSON.stringify({
                lexicalRank: matches[i].lexicalRank,
                semanticRank: matches[i].semanticRank,
                lexicalScore: matches[i].lexicalScore,
                semanticSimilarity: matches[i].semanticSimilarity,
                lexicalContribution: matches[i].lexicalRank
                  ? 1 / (60 + matches[i].lexicalRank!)
                  : 0,
                semanticContribution: matches[i].semanticRank
                  ? 1 / (60 + matches[i].semanticRank!)
                  : 0,
                ...matches[i].diagnostics,
              })
            : undefined,
      }),
    );
    const note = notes.get(matches[i].section.filePath);
    if (note) lines.push(`  ${formatProvenanceNote(note, ctx.styler)}`);
  }
  lines.push('');
  return lines.join('\n');
}

export async function searchCommand(
  ctx: CmdContext,
  query: string | undefined,
  opts: {
    limit: number;
    debug?: boolean;
    minSimilarity?: number;
    preview?: 'passage' | 'intro' | 'both';
  },
  progress?: IndexProgress,
): Promise<CmdResult> {
  const s = ctx.styler;
  try {
    if (!query) {
      await runIndex(ctx.latDir, progress, await commandProjectAnalysis(ctx));
      return { output: '' };
    }

    const project = await commandProjectAnalysis(ctx);
    const result = await runSearch(ctx.latDir, query, opts.limit, progress, {
      project,
      minSimilarity: opts.minSimilarity,
    });

    if (result.matches.length === 0) {
      return { output: 'No results found.' };
    }

    return {
      output:
        (await formatSearchMatches(ctx, query, result.matches, {
          showScores: opts.debug,
          preview: opts.preview ?? 'passage',
        })) + formatNavHints(ctx),
    };
  } catch (err) {
    // The stored index can't be served in the current environment — never
    // switch backends silently; direct the user to `lat reindex`.
    if (err instanceof ReindexRequiredError) {
      return { output: s.red(err.message), isError: true };
    }
    if (err instanceof EmbeddingAuthError) {
      return {
        output:
          s.red(`LAT_LLM_KEY was rejected by the provider (${err.status}).`) +
          ' Run ' +
          s.cyan('lat reindex') +
          ' to fix the key or switch to the local model.',
        isError: true,
      };
    }
    // Config/key resolution errors (e.g. empty LAT_LLM_KEY_FILE) or other
    // failures — surface the message rather than crashing.
    return { output: (err as Error).message, isError: true };
  }
}
