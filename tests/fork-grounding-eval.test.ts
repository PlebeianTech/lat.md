import {
   describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from 'vitest';
import { Buffer } from 'node:buffer';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { plainStyler, type CmdContext } from '@plebeiantech/lat.md-core/context';
import type { Section, SectionMatch, Ref } from '@plebeiantech/lat.md-core/lattice-model';
import { formatSectionOutput, type SectionFound } from '@plebeiantech/lat.md-core/cli/section';
import type { MarkdownProjectAnalysis } from '@plebeiantech/lat.md-core/project-analysis';
import type { CheckRunContext } from '@plebeiantech/lat.md-core/cli/check-context';
import {
  PROMPT_SEARCH_MAX_BYTES,
  NAVIGATION_HINT,
  formatPromptSearchMatches,
} from '../src/cli/fork-prompt-search.js';
import {
  findUngroundedPromptFiles,
  formatCoverageGapNotice,
  buildWikiGroundedSet,
  isPathWikiGrounded,
} from '../src/cli/fork-coverage-preflight.js';
import {
  findImpactedSectionsForDiff,
  parseUnifiedZeroDiff,
} from '../src/cli/fork-stop-impact.js';
import {
  buildGraph,
  formatGraphJson,
  type GraphSourceFile,
} from '../src/graph-export.js';
import { rmDirBestEffort } from './util.js';

const casesDir = join(import.meta.dirname, 'cases');
const cliPath = join(
  import.meta.dirname,
  '..',
  'dist',
  'src',
  'cli',
  'index.js',
);

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

interface SearchCorpusItem {
  match: SectionMatch;
  found: SectionFound;
}

interface SearchCorpusCase {
  name: string;
  items: SearchCorpusItem[];
}

function makeSectionFoundItem(
  id: string,
  filePath: string,
  startLine: number,
  endLine: number,
  heading: string,
  firstParagraph: string,
  paragraphs: string[],
  outgoingRefs: string[] = [],
  incomingRefs: string[] = [],
  codeRefs: { file: string; line: number; name: string }[] = [],
): SearchCorpusItem {
  const section: Section = {
    id,
    heading,
    depth: 2,
    file: filePath.split('/').pop()!,
    filePath,
    children: [],
    startLine,
    endLine,
    firstParagraph,
  };
  const bodyText = [
    heading ? `## ${heading}\n` : '',
    firstParagraph,
    '',
    ...paragraphs,
  ].join('\n');
  return {
    match: { section, reason: 'evaluation match', rankScore: 0.95 },
    found: {
      kind: 'found',
      section,
      content: bodyText,
      status: null,
      outgoingRefs: outgoingRefs.map((target) => ({
        target,
        resolved: {
          id: target,
          heading: target.split('#').pop()!,
          depth: 2,
          file: 'resolved.md',
          filePath: 'lat.md/resolved.md',
          children: [],
          startLine: 1,
          endLine: 20,
          firstParagraph: 'Resolved target overview summary.',
        },
      })),
      outgoingSourceRefs: [],
      outgoingExternalRefs: [],
      incomingRefs: incomingRefs.map((incId) => ({
        section: {
          id: incId,
          heading: incId.split('#').pop()!,
          depth: 2,
          file: 'caller.md',
          filePath: 'lat.md/caller.md',
          children: [],
          startLine: 1,
          endLine: 20,
          firstParagraph: 'Caller section overview summary.',
        },
        reason: 'wiki link',
        citeFile: 'lat.md/caller.md',
        citeLine: 42,
      })),
      codeRefs: codeRefs.map((c) => ({
        file: c.file,
        line: c.line,
        snippet: `export function ${c.name}() {\n  return true;\n}`,
      })),
    },
  };
}

function baselineFormatPromptSearchResults(
  ctx: CmdContext,
  items: SearchCorpusItem[],
): string {
  const parts: string[] = [
    `Search results for the user prompt (${items.length} matches):`,
    '',
  ];
  for (const item of items) {
    parts.push(formatSectionOutput(ctx, item.found));
    parts.push('');
  }
  return parts.join('\n');
}

const SEARCH_CORPUS: SearchCorpusCase[] = [
  {
    name: 'Auth & Tokens',
    items: [
      makeSectionFoundItem(
        'auth#Authentication#OAuth2',
        'lat.md/auth.md',
        15,
        65,
        'OAuth2',
        'OAuth2 authentication negotiates access tokens via authorization code exchange with PKCE verification.',
        [
          'The authorization server validates incoming code challenges against code verifiers sent by the client. Successful validation grants an authorization token.',
          'Refresh tokens are issued alongside short-lived access tokens. Clients must store refresh tokens securely and renew them before expiration to maintain uninterrupted sessions.',
        ],
        ['auth#Tokens#Storage'],
        ['cli#CLI#login'],
        [{ file: 'src/auth/oauth.ts', line: 45, name: 'exchangeCode' }],
      ),
      makeSectionFoundItem(
        'auth#Tokens#Storage',
        'lat.md/auth.md',
        66,
        115,
        'Storage',
        'Token storage securely persists refresh and access tokens in OS credential vaults or encrypted keystores.',
        [
          'On macOS, credentials use the Keychain Services API. On Linux systems, libsecret or secret-service DBus interfaces store serialized credentials.',
          'When vault storage fails, encrypted local file storage acts as a degraded fallback using AES-256-GCM encryption with user-isolated filesystem permissions.',
        ],
        ['auth#Tokens#Rotation'],
        ['auth#Authentication#OAuth2'],
        [{ file: 'src/auth/storage.ts', line: 28, name: 'storeToken' }],
      ),
      makeSectionFoundItem(
        'auth#Tokens#Rotation',
        'lat.md/auth.md',
        116,
        160,
        'Rotation',
        'Token rotation issues single-use refresh tokens on renewal and revokes entire family chains on reuse detection.',
        [
          'Each token refresh increments the rotation counter and invalidates the previous refresh token. Tokens carry cryptographic generation markers.',
          'If an invalid or previously used refresh token is presented, the authorization server assumes token compromise and revokes all active child sessions immediately.',
        ],
        ['auth#Tokens#Revocation'],
        ['auth#Tokens#Storage'],
        [{ file: 'src/auth/rotate.ts', line: 33, name: 'rotateToken' }],
      ),
      makeSectionFoundItem(
        'auth#Tokens#Revocation',
        'lat.md/auth.md',
        161,
        205,
        'Revocation',
        'Token revocation invalidates refresh tokens and blacklists active JWTs across cluster nodes immediately.',
        [
          'Revocation requests broadcast session identifiers across Redis pub/sub channels to ensure sub-second eviction across edge API gateways.',
          'Local gateway caches maintain Bloom filters of revoked session tokens to reject revoked requests without incurring remote database round trips.',
        ],
        [],
        ['auth#Tokens#Rotation'],
        [{ file: 'tests/auth/revocation.test.ts', line: 50, name: 'testRevoke' }],
      ),
    ],
  },
  {
    name: 'Search Pipeline',
    items: [
      makeSectionFoundItem(
        'search#Retrieval#LexicalScan',
        'lat.md/search.md',
        20,
        75,
        'LexicalScan',
        'Lexical scan queries Tantivy FTS indexes using stemmed English tokens and exact identifier filters.',
        [
          'Passage body, section headings, and ancestor paths are indexed in separate columns with weighted relevance (body 1.0, heading 2.0, path 0.5).',
          'Queries pass through porter stemming and stop word filtering before executing BM25 term frequency calculations across the passage index.',
        ],
        ['search#Retrieval#RRF'],
        ['cli#CLI#search'],
        [{ file: 'src/search/lexical.ts', line: 40, name: 'lexicalTokens' }],
      ),
      makeSectionFoundItem(
        'search#Retrieval#SemanticCosine',
        'lat.md/search.md',
        76,
        130,
        'SemanticCosine',
        'Semantic search computes exact cosine similarity between query embeddings and stored 384-dimensional vectors.',
        [
          'Vectors are computed using quantized local MiniLM models or remote embedding endpoints. Dot products are normalized to unit magnitude.',
          'Candidates below the 0.20 cosine floor are pruned before rank aggregation, filtering noisy passage comparisons.',
        ],
        ['search#Retrieval#RRF'],
        ['cli#CLI#search'],
        [{ file: 'src/search/search.ts', line: 65, name: 'searchSections' }],
      ),
      makeSectionFoundItem(
        'search#Retrieval#RRF',
        'lat.md/search.md',
        131,
        185,
        'RRF',
        'Reciprocal rank fusion combines lexical and semantic ranks with constant k=60 without summing raw scores.',
        [
          'RRF calculates reciprocal scores 1 / (60 + rank) for each channel match. Independent channels allow balanced hybrid retrieval across lexical and semantic signals.',
          'Section-level collapsing ensures each section appears at most once in final rankings, taking its highest-scoring passage rank.',
        ],
        [],
        ['search#Retrieval#LexicalScan', 'search#Retrieval#SemanticCosine'],
        [{ file: 'tests/search.test.ts', line: 140, name: 'testRrf' }],
      ),
      makeSectionFoundItem(
        'search#Storage#CacheLocking',
        'lat.md/search.md',
        186,
        240,
        'CacheLocking',
        'Search database concurrency enforces separate read and exclusive write locks via persistent OS file descriptors.',
        [
          'Readers acquire shared advisory locks allowing concurrent query execution. Writers hold exclusive locks during database compaction and reindexing.',
          'Lock acquisition features timeout bounds to prevent deadlocks when background indexing processes terminate abruptly.',
        ],
        [],
        ['search#Retrieval#LexicalScan'],
        [{ file: 'src/search/lock.ts', line: 55, name: 'acquireSearchLock' }],
      ),
    ],
  },
  {
    name: 'CLI Hooks',
    items: [
      makeSectionFoundItem(
        'cli#CLI#hook#UserPromptSubmit',
        'lat.md/cli.md',
        80,
        145,
        'UserPromptSubmit',
        'UserPromptSubmit intercepts developer prompts to inject budgeted search context and ungrounded file preflight notices.',
        [
          'When a developer submits a prompt, background search finds relevant sections while file preflight checks for ungrounded files.',
          'Context injection enriches agent grounding while staying within strict byte budgets to prevent context window saturation.',
        ],
        ['cli#CLI#hook#Preflight'],
        ['cli#CLI#overview'],
        [{ file: 'src/cli/hook.ts', line: 142, name: 'handleUserPromptSubmit' }],
      ),
      makeSectionFoundItem(
        'cli#CLI#hook#PostToolUse',
        'lat.md/cli.md',
        146,
        200,
        'PostToolUse',
        'PostToolUse reminds agents of code reference conventions when file edits or writes introduce comments without @lat annotations.',
        [
          'File changes performed via Edit or Write tools are parsed for newly introduced comments.',
          'If code comments lack @lat section links, a reminder notification is returned to encourage knowledge graph maintenance.',
        ],
        [],
        ['cli#CLI#overview'],
        [{ file: 'src/cli/hook.ts', line: 248, name: 'handlePostToolUse' }],
      ),
      makeSectionFoundItem(
        'cli#CLI#hook#Stop',
        'lat.md/cli.md',
        201,
        260,
        'Stop',
        'Stop hook blocks termination when codebase changes exceed ratio thresholds without corresponding lat.md updates.',
        [
          'Git diff status is evaluated against modified lat.md documentation lines. If code changes exceed the ratio threshold, stop is blocked.',
          'Impacted sections are resolved by intersecting changed line numbers with registered @lat references.',
        ],
        [],
        ['cli#CLI#overview'],
        [{ file: 'src/cli/hook.ts', line: 522, name: 'handleStop' }],
      ),
      makeSectionFoundItem(
        'cli#CLI#hook#Preflight',
        'lat.md/cli.md',
        261,
        315,
        'Preflight',
        'Coverage preflight inspects prompt tokens against wiki links and code comments to detect disconnected implementation files.',
        [
          'Prompt tokens are normalized and evaluated against known repository source files.',
          'Files lacking documentation links trigger guidance instructing developers to add @lat annotations.',
        ],
        [],
        ['cli#CLI#hook#UserPromptSubmit'],
        [{ file: 'tests/fork-coverage-preflight.test.ts', line: 48, name: 'testPreflight' }],
      ),
    ],
  },
  {
    name: 'Parser & AST',
    items: [
      makeSectionFoundItem(
        'parser#Markdown#DiataxisModes',
        'lat.md/parser.md',
        10,
        60,
        'DiataxisModes',
        'Diataxis mode verification validates structural shapes for tutorials, how-tos, reference sheets, and explanations.',
        [
          'Tutorials and how-to guides require ordered procedural steps. Reference files enforce strict fact tables without narrative paragraphs.',
          'Explanations disallow imperative directives, focusing on architectural rationale and background context.',
        ],
        ['parser#Markdown#WikiLinkResolution'],
        ['check#Check#mode'],
        [{ file: 'packages/core/src/cli/check-mode.ts', line: 25, name: 'checkMode' }],
      ),
      makeSectionFoundItem(
        'parser#Markdown#WikiLinkResolution',
        'lat.md/parser.md',
        61,
        110,
        'WikiLinkResolution',
        'Wiki link resolution maps double-bracket targets against section IDs, file slugs, repository paths, and source symbols.',
        [
          'Target paths are matched against in-memory section trees with fuzzy file stem expansion.',
          'Symbol targets resolve class and function declarations via tree-sitter grammars.',
        ],
        ['parser#Markdown#HeadingTree'],
        ['parser#Markdown#DiataxisModes'],
        [{ file: 'packages/core/src/lattice-model.ts', line: 80, name: 'resolveRef' }],
      ),
      makeSectionFoundItem(
        'parser#Markdown#HeadingTree',
        'lat.md/parser.md',
        111,
        160,
        'HeadingTree',
        'Heading tree construction parses nested markdown headers into a hierarchy with stable section identifiers and line spans.',
        [
          'Markdown-it AST tokens build nested section nodes tracking start and end lines.',
          'Every section verifies that its first paragraph is non-empty and does not exceed 250 characters.',
        ],
        ['parser#Markdown#CodeRefExtraction'],
        ['parser#Markdown#WikiLinkResolution'],
        [{ file: 'packages/core/src/markdown-analysis.ts', line: 45, name: 'analyzeMarkdown' }],
      ),
      makeSectionFoundItem(
        'parser#Markdown#CodeRefExtraction',
        'lat.md/parser.md',
        161,
        210,
        'CodeRefExtraction',
        'Code reference extraction scans comments across all supported programming languages for @lat annotations.',
        [
          'Source lines are scanned for language-specific comment tokens carrying lat wiki brackets.',
          'Scanned references link source locations directly to governing architecture sections.',
        ],
        [],
        ['parser#Markdown#HeadingTree'],
        [{ file: 'packages/core/src/code-refs.ts', line: 30, name: 'extractCodeRefs' }],
      ),
      makeSectionFoundItem(
        'parser#Markdown#FrontmatterPlacement',
        'lat.md/parser.md',
        211,
        260,
        'FrontmatterPlacement',
        'Frontmatter parsing reads document metadata above the first heading and validates schema attributes.',
        [
          'Frontmatter YAML blocks configure mode overrides and code reference requirements.',
          'Validation ensures frontmatter syntax conforms to schema rules.',
        ],
        [],
        ['parser#Markdown#DiataxisModes'],
        [{ file: 'tests/frontmatter-placement.test.ts', line: 40, name: 'testFrontmatter' }],
      ),
    ],
  },
  {
    name: 'Graph Export',
    items: [
      makeSectionFoundItem(
        'graph#Export#NodeIdentity',
        'lat.md/graph.md',
        10,
        70,
        'NodeIdentity',
        'Graph export builds an indexed node dictionary representing sections, documents, source files, and external entities.',
        [
          'Each node receives a unique uniform identifier based on relative path and section hierarchy.',
          'Nodes encapsulate display titles, line ranges, and cluster memberships.',
        ],
        ['graph#Export#SemanticEdgeRoles'],
        ['cli#CLI#graph'],
        [{ file: 'src/graph-export.ts', line: 45, name: 'buildGraph' }],
      ),
      makeSectionFoundItem(
        'graph#Export#SemanticEdgeRoles',
        'lat.md/graph.md',
        71,
        140,
        'SemanticEdgeRoles',
        'Semantic edge classification enriches raw graph links with roles: section-ref, symbol-ref, test-spec-ref, implements, and verifies.',
        [
          'Edges connecting code to tests receive verifies roles, while implementation links receive implements roles.',
          'Wiki links are classified into section-ref, symbol-ref, or test-spec-ref based on target type.',
        ],
        ['graph#Export#CytoscapeFormatter'],
        ['graph#Export#NodeIdentity'],
        [{ file: 'src/graph-export.ts', line: 115, name: 'classifyEdgeRole' }],
      ),
      makeSectionFoundItem(
        'graph#Export#CytoscapeFormatter',
        'lat.md/graph.md',
        141,
        210,
        'CytoscapeFormatter',
        'Cytoscape export formats vertices and directed edges into JSON structures suitable for browser graph visualization.',
        [
          'Cytoscape JSON payloads represent nodes and edges with visual styling attributes.',
          'Positioning algorithms layout hierarchical and dependency clusters.',
        ],
        [],
        ['graph#Export#SemanticEdgeRoles'],
        [{ file: 'tests/fork-graph-edge-roles.test.ts', line: 70, name: 'testCytoscape' }],
      ),
    ],
  },
];

interface PreflightCorpusItem {
  prompt: string;
  expected: string[];
}

function naiveCheck(
  project: MarkdownProjectAnalysis,
  userPrompt: string,
): string[] {
  const tokens = userPrompt.split(/\s+/);
  const naiveUngrounded: string[] = [];
  const wikiSet = buildWikiGroundedSet(project.wikiRefs);
  for (const raw of tokens) {
    let token = raw
      .replace(/^['"`\(\[<,;:]+/, '')
      .replace(/['"`\)\]>,;:\.]+$/, '');
    if (!token) continue;
    token = token.replace(/:\d+(?::\d+)?$/, '');
    const hashIdx = token.indexOf('#');
    if (hashIdx !== -1) token = token.slice(0, hashIdx);
    token = token.replace(/['"`\)\]>,;:\.]+$/, '');
    if (/\.(?:ts|tsx|js|jsx|py|rs|go|json)$/i.test(token)) {
      const full = join(project.projectRoot, token);
      if (existsSync(full) && statSync(full).isFile()) {
        if (!isPathWikiGrounded(token, wikiSet)) {
          if (!naiveUngrounded.includes(token)) naiveUngrounded.push(token);
        }
      }
    }
  }
  return naiveUngrounded.sort();
}

const LABELED_PREFLIGHT_CORPUS: PreflightCorpusItem[] = [
  {
    prompt: 'Please refactor `src/components/button.tsx` to add support for an asynchronous loading spinner state.',
    expected: [],
  },
  {
    prompt: 'Investigate the command dispatch error handling in `src/cli/commands.ts:42`.',
    expected: [],
  },
  {
    prompt: 'Check `src/search/query.ts#openIndexedSearchSession` to ensure search sessions release access locks on close.',
    expected: [],
  },
  {
    prompt: 'Add color formatting options to (src/format.ts:88) to support 256-color terminals.',
    expected: [],
  },
  {
    prompt: 'Audit session token expiration and renewal logic in `src/auth/session.ts`.',
    expected: [],
  },
  {
    prompt: 'Optimize background task retry delays in `src/workers/dispatcher.py` to prevent task thrashing.',
    expected: [],
  },
  {
    prompt: 'Review hardware secure enclave integration in `src/crypto/vault.rs:50`.',
    expected: [],
  },
  {
    prompt: 'Inspect database connection pool lifecycle in `src/storage/db.go` under high concurrency.',
    expected: [],
  },
  {
    prompt: 'Implement webhook signature validation in `src/billing/stripe.ts` for incoming charges.',
    expected: ['src/billing/stripe.ts'],
  },
  {
    prompt: 'Fix formatting in `src/notifications/slack.py#postMessage` when alert payloads contain markdown code blocks.',
    expected: ['src/notifications/slack.py'],
  },
  {
    prompt: 'Investigate memory consumption in `src/metrics/telemetry.rs:120:15` during high-volume metric ingestion.',
    expected: ['src/metrics/telemetry.rs'],
  },
  {
    prompt: 'Please migrate `src/legacy/compat.go` and `src/billing/stripe.ts#handleWebhook` to new context interfaces.',
    expected: ['src/billing/stripe.ts', 'src/legacy/compat.go'],
  },
  {
    prompt: 'Update `vitest.config.ts` to increase default test timeout to 15 seconds.',
    expected: [],
  },
  {
    prompt: 'Adjust bundle chunking options in `vite.config.ts` for browser builds.',
    expected: [],
  },
  {
    prompt: 'Add process.env definitions to `env.d.ts` for Cloudflare Workers bindings.',
    expected: [],
  },
  {
    prompt: 'Bump dependency versions in `package.json` and check `vitest.config.ts` compatibility.',
    expected: [],
  },
];

interface DiffFixture {
  id: string;
  category: string;
  diffText: string;
  sectionIds: string[];
  codeRefs: Array<{ file: string; line: number; target: string }>;
  wikiRefs: Ref[];
  expectedSections: string[];
}

function makeMockDiffProject(
  projectRoot: string,
  wikiRefs: Ref[] = [],
  sectionIds: string[] = [],
): MarkdownProjectAnalysis {
  const sectionIdSet = new Set(sectionIds.map((id) => id.toLowerCase()));
  const sectionById = new Map<string, any>(
    sectionIds.map((id) => [
      id.toLowerCase(),
      { id, heading: id.split('#').pop()!, file: id.split('#')[0] },
    ]),
  );
  const fileIndex = new Map<string, string[]>();
  for (const id of sectionIds) {
    const hashIdx = id.indexOf('#');
    const file = (hashIdx === -1 ? id : id.slice(0, hashIdx)).toLowerCase();
    const existing = fileIndex.get(file) ?? [];
    existing.push(file);
    fileIndex.set(file, existing);
  }
  return {
    latDir: join(projectRoot, 'lat.md'),
    projectRoot,
    entries: [],
    markdownFiles: [],
    files: new Map(),
    filesByAbsolutePath: new Map(),
    allSections: [],
    sections: [],
    sectionById,
    sectionIds: sectionIdSet,
    fileIndex,
    slugIndex: new Map() as any,
    wikiRefs,
    outgoingRefsBySection: new Map(),
    refsByTarget: new Map(),
    incomingRefsBySection: new Map(),
  } as unknown as MarkdownProjectAnalysis;
}

function makeMockCheckRun(
  project: MarkdownProjectAnalysis,
  refs: Array<{ file: string; line: number; target: string }> = [],
): CheckRunContext {
  return {
    project: async () => project,
    codeRefs: async () => ({ refs }),
  } as unknown as CheckRunContext;
}

function naiveDiffToSections(
  diffText: string,
  project: MarkdownProjectAnalysis,
  codeRefs: { refs: Array<{ file: string; line: number; target: string }> },
): string[] {
  const lines = diffText.split(/\r?\n/);
  const ranges: Array<{ file: string; startLine: number; endLine: number }> = [];
  let currentFile: string | null = null;

  for (const line of lines) {
    if (line.startsWith('--- a/')) {
      currentFile = line.slice(6).trim();
      continue;
    }
    if (line.startsWith('+++ b/')) {
      currentFile = line.slice(6).trim();
      continue;
    }
    if (currentFile && line.startsWith('@@ ')) {
      const match = line.match(/^@@\s+-[0-9]+(?:,[0-9]+)?\s+\+([0-9]+)(?:,([0-9]+))?\s+@@/);
      if (match) {
        const startLine = parseInt(match[1], 10);
        const count = match[2] !== undefined ? parseInt(match[2], 10) : 1;
        ranges.push({
          file: currentFile,
          startLine,
          endLine: Math.max(startLine, startLine + count - 1),
        });
      }
    }
  }

  const matched = new Set<string>();
  for (const r of ranges) {
    const fileRefs = (codeRefs.refs || []).filter(
      (cr) => cr.file.toLowerCase() === r.file.toLowerCase(),
    );
    for (const cr of fileRefs) {
      if (cr.line >= r.startLine - 15 && cr.line <= r.endLine + 15) {
        matched.add(cr.target);
      }
    }
    for (const ref of project.wikiRefs || []) {
      const rawTarget = ref.target.split('#')[0].trim();
      if (rawTarget.toLowerCase() === r.file.toLowerCase()) {
        matched.add(ref.fromSection);
      }
    }
  }

  return Array.from(matched).sort();
}

const DIFF_CORPUS: DiffFixture[] = [
  {
    id: 'diff-near-comment',
    category: 'near-comment',
    diffText: `--- a/src/auth/token.ts\n+++ b/src/auth/token.ts\n@@ -10,3 +10,4 @@\n@@ -18,2 +19,3 @@`,
    sectionIds: ['auth#Authentication#Token Validation'],
    codeRefs: [{ file: 'src/auth/token.ts', line: 12, target: 'auth#Authentication#Token Validation' }],
    wikiRefs: [],
    expectedSections: ['auth#Authentication#Token Validation'],
  },
  {
    id: 'diff-deep-function',
    category: 'deep-function',
    diffText: `--- a/src/compiler/parser.ts\n+++ b/src/compiler/parser.ts\n@@ -65,5 +65,8 @@\n@@ -95,2 +98,4 @@`,
    sectionIds: ['compiler#Compiler#Syntax Analysis'],
    codeRefs: [{ file: 'src/compiler/parser.ts', line: 15, target: 'compiler#Compiler#Syntax Analysis' }],
    wikiRefs: [],
    expectedSections: ['compiler#Compiler#Syntax Analysis'],
  },
  {
    id: 'diff-wikilink-symbol',
    category: 'wikilink-symbol',
    diffText: `--- a/src/math/vector.ts\n+++ b/src/math/vector.ts\n@@ -30,4 +30,6 @@\n@@ -80,2 +82,5 @@`,
    sectionIds: ['geometry#Geometry#Vector Operations'],
    codeRefs: [],
    wikiRefs: [{ target: 'src/math/vector.ts#crossProduct', fromSection: 'geometry#Geometry#Vector Operations', file: 'lat.md/geometry.md', line: 1 }],
    expectedSections: ['geometry#Geometry#Vector Operations'],
  },
  {
    id: 'diff-pure-deletion',
    category: 'pure-deletion',
    diffText: `--- a/src/database/query.ts\n+++ b/src/database/query.ts\n@@ -50,15 +50,0 @@\n@@ -80,8 +65,0 @@`,
    sectionIds: ['db#Database#Query Builder'],
    codeRefs: [{ file: 'src/database/query.ts', line: 20, target: 'db#Database#Query Builder' }],
    wikiRefs: [],
    expectedSections: ['db#Database#Query Builder'],
  },
  {
    id: 'diff-deleted-file-dev-null',
    category: 'deleted-file',
    diffText: `--- a/src/legacy/obsolete.ts\n+++ /dev/null\n@@ -1,60 +0,0 @@`,
    sectionIds: ['legacy#Legacy#Obsolete Helpers', 'legacy#Legacy#Overview'],
    codeRefs: [{ file: 'src/legacy/obsolete.ts', line: 5, target: 'legacy#Legacy#Obsolete Helpers' }],
    wikiRefs: [{ target: 'src/legacy/obsolete.ts', fromSection: 'legacy#Legacy#Overview', file: 'lat.md/legacy.md', line: 1 }],
    expectedSections: [],
  },
  {
    id: 'diff-multi-file-composite',
    category: 'multi-file-composite',
    diffText: `diff --git a/src/net/router.ts b/src/net/router.ts\n--- a/src/net/router.ts\n+++ b/src/net/router.ts\n@@ -12,2 +12,4 @@\n@@ -75,3 +77,5 @@\ndiff --git a/src/net/handler.ts b/src/net/handler.ts\n--- a/src/net/handler.ts\n+++ b/src/net/handler.ts\n@@ -35,2 +35,3 @@\ndiff --git a/src/trash/dead.ts b/dev/null\n--- a/src/trash/dead.ts\n+++ /dev/null\n@@ -1,25 +0,0 @@`,
    sectionIds: ['net#Networking#Request Handler', 'net#Networking#Routing Engine', 'trash#DeadCode#Old'],
    codeRefs: [
      { file: 'src/net/router.ts', line: 10, target: 'net#Networking#Routing Engine' },
      { file: 'src/trash/dead.ts', line: 5, target: 'trash#DeadCode#Old' },
    ],
    wikiRefs: [
      { target: 'src/net/handler.ts#handleRequest', fromSection: 'net#Networking#Request Handler', file: 'lat.md/net.md', line: 1 },
    ],
    expectedSections: ['net#Networking#Request Handler', 'net#Networking#Routing Engine'],
  },
];

describe('Fork Grounding Evaluation Suite', () => {
  const evalCtx: CmdContext = {
    projectRoot: process.cwd(),
    latDir: join(process.cwd(), 'lat.md'),
    styler: plainStyler,
    mode: 'cli',
  };

  beforeEach(() => {
    getSectionSpy.mockClear();
  });

  describe('Suite 1: Prompt Search Budget Ablation', () => {
    // @lat: [[fork-grounding-eval#Fork Grounding Eval#Multi-match baseline exceeds budget]]
    it('exceeds byte budget across all baseline unbudgeted multi-match results', () => {
      for (const testCase of SEARCH_CORPUS) {
        const baselineOutput = baselineFormatPromptSearchResults(evalCtx, testCase.items);
        const baselineBytes = Buffer.byteLength(baselineOutput, 'utf-8');
        expect(
          baselineBytes,
          `Baseline for ${testCase.name} should exceed 2500 bytes`,
        ).toBeGreaterThan(PROMPT_SEARCH_MAX_BYTES);
      }
    });

    // @lat: [[fork-grounding-eval#Fork Grounding Eval#Multi-match fork achieves sixty percent byte reduction]]
    it('achieves at least sixty percent byte reduction across multi-match results', async () => {
      for (const testCase of SEARCH_CORPUS) {
        const baselineOutput = baselineFormatPromptSearchResults(evalCtx, testCase.items);
        const baselineBytes = Buffer.byteLength(baselineOutput, 'utf-8');

        const matches = testCase.items.map((i) => i.match);
        const forkOutput = await formatPromptSearchMatches(
          evalCtx,
          matches,
          PROMPT_SEARCH_MAX_BYTES,
        );
        expect(forkOutput).not.toBeNull();
        const forkBytes = Buffer.byteLength(forkOutput!, 'utf-8');

        const reductionPct = ((baselineBytes - forkBytes) / baselineBytes) * 100;
        expect(
          reductionPct,
          `Byte reduction for ${testCase.name} should be >= 60%`,
        ).toBeGreaterThanOrEqual(60);
      }
    });

    // @lat: [[fork-grounding-eval#Fork Grounding Eval#Multi-match fork stays within hard byte budget]]
    it('stays at or below 2500 bytes for all multi-match cases', async () => {
      for (const testCase of SEARCH_CORPUS) {
        const matches = testCase.items.map((i) => i.match);
        const forkOutput = await formatPromptSearchMatches(
          evalCtx,
          matches,
          PROMPT_SEARCH_MAX_BYTES,
        );
        expect(forkOutput).not.toBeNull();
        const forkBytes = Buffer.byteLength(forkOutput!, 'utf-8');
        expect(
          forkBytes,
          `Fork output for ${testCase.name} must stay <= 2500 bytes`,
        ).toBeLessThanOrEqual(PROMPT_SEARCH_MAX_BYTES);
      }
    });

    // @lat: [[fork-grounding-eval#Fork Grounding Eval#Multi-match fork retains complete identifier and location coordinates]]
    it('retains section id and file:startLine-endLine coordinate for every included match', async () => {
      for (const testCase of SEARCH_CORPUS) {
        const matches = testCase.items.map((i) => i.match);
        const forkOutput = await formatPromptSearchMatches(
          evalCtx,
          matches,
          PROMPT_SEARCH_MAX_BYTES,
        );
        expect(forkOutput).not.toBeNull();
        for (const item of testCase.items) {
          const s = item.match.section;
          expect(forkOutput).toContain(`[[${s.id}]]`);
          expect(forkOutput).toContain(`${s.filePath}:${s.startLine}-${s.endLine}`);
        }
      }
    });

    // @lat: [[fork-grounding-eval#Fork Grounding Eval#Single match within budget emits full section body]]
    it('emits full section content when a single match fits within budget', async () => {
      const item = SEARCH_CORPUS[0].items[0];
      getSectionSpy.mockResolvedValueOnce(item.found);

      const result = await formatPromptSearchMatches(
        evalCtx,
        [item.match],
        PROMPT_SEARCH_MAX_BYTES,
      );

      expect(result).not.toBeNull();
      expect(result).toContain('Search results for the user prompt (1 matches):');
      expect(result).toContain(item.match.section.firstParagraph);
      expect(result).not.toContain(NAVIGATION_HINT);
      expect(Buffer.byteLength(result!, 'utf-8')).toBeLessThanOrEqual(
        PROMPT_SEARCH_MAX_BYTES,
      );
    });

    // @lat: [[fork-grounding-eval#Fork Grounding Eval#Single match exceeding budget falls back to compact preview]]
    it('falls back to compact preview when a single match exceeds budget', async () => {
      const item = SEARCH_CORPUS[0].items[0];
      const massiveFound: SectionFound = {
        ...item.found,
        content: 'Massive content line\n'.repeat(300),
      };
      getSectionSpy.mockResolvedValueOnce(massiveFound);

      const result = await formatPromptSearchMatches(
        evalCtx,
        [item.match],
        PROMPT_SEARCH_MAX_BYTES,
      );

      expect(result).not.toBeNull();
      expect(result).toContain('Search results for the user prompt (1 matches):');
      expect(result).toContain(`[[${item.match.section.id}]]`);
      expect(result).toContain(NAVIGATION_HINT);
      expect(result).not.toContain('Massive content line');
      expect(Buffer.byteLength(result!, 'utf-8')).toBeLessThanOrEqual(
        PROMPT_SEARCH_MAX_BYTES,
      );
    });
  });

  describe('Suite 2: Prompt File-Coverage Preflight Corpus', () => {
    let tempDir: string;
    let mockProject: MarkdownProjectAnalysis;

    beforeEach(() => {
      tempDir = mkdtempSync(join(tmpdir(), 'fork-eval-preflight-'));
      const srcDir = join(tempDir, 'src');
      const subdirs = [
        'components', 'cli', 'search', 'auth', 'workers',
        'crypto', 'storage', 'billing', 'notifications', 'metrics', 'legacy',
      ];
      for (const sub of subdirs) {
        mkdirSync(join(srcDir, sub), { recursive: true });
      }

      writeFileSync(join(srcDir, 'components', 'button.tsx'), 'export const Button = () => null;\n');
      writeFileSync(join(srcDir, 'cli', 'commands.ts'), 'export const runCli = () => null;\n');
      writeFileSync(join(srcDir, 'search', 'query.ts'), 'export const openIndexedSearchSession = () => null;\n');
      writeFileSync(join(srcDir, 'format.ts'), 'export const formatText = () => null;\n');

      writeFileSync(join(srcDir, 'auth', 'session.ts'), '// @lat: [[auth#Session#Validation]]\nexport function validate() {}\n');
      writeFileSync(join(srcDir, 'workers', 'dispatcher.py'), '# @lat: [[workers#JobQueue#Dispatch]]\ndef dispatch(): pass\n');
      writeFileSync(join(srcDir, 'crypto', 'vault.rs'), '// @lat: [[crypto#Vault#Keystore]]\npub fn unlock() {}\n');
      writeFileSync(join(srcDir, 'storage', 'db.go'), '// @lat: [[storage#Database#Pool]]\nfunc Connect() {}\n');

      writeFileSync(join(srcDir, 'billing', 'stripe.ts'), 'export function charge() {}\n');
      writeFileSync(join(srcDir, 'notifications', 'slack.py'), 'def postMessage(): pass\n');
      writeFileSync(join(srcDir, 'metrics', 'telemetry.rs'), 'pub fn record() {}\n');
      writeFileSync(join(srcDir, 'legacy', 'compat.go'), 'func Compat() {}\n');

      writeFileSync(join(tempDir, 'vitest.config.ts'), 'export default {};\n');
      writeFileSync(join(tempDir, 'vite.config.ts'), 'export default {};\n');
      writeFileSync(join(tempDir, 'env.d.ts'), 'declare var API: string;\n');
      writeFileSync(join(tempDir, 'package.json'), '{\n  "name": "eval-pkg"\n}\n');

      mockProject = {
        projectRoot: tempDir,
        latDir: join(tempDir, 'lat.md'),
        entries: [],
        markdownFiles: [],
        files: new Map(),
        filesByAbsolutePath: new Map(),
        allSections: [],
        sections: [],
        sectionById: new Map(),
        sectionIds: new Set(),
        fileIndex: new Map(),
        slugIndex: new Map() as any,
        wikiRefs: [
          { target: 'src/components/button.tsx#Button', fromSection: 'ui#Button', file: 'lat.md/ui.md', line: 10 },
          { target: 'src/cli/', fromSection: 'cli#Overview', file: 'lat.md/cli.md', line: 15 },
          { target: 'src/search/query.ts#openIndexedSearchSession', fromSection: 'search#Pipeline', file: 'lat.md/search.md', line: 20 },
          { target: 'src/format.ts#formatText', fromSection: 'format#Overview', file: 'lat.md/format.md', line: 5 },
        ],
        outgoingRefsBySection: new Map(),
        refsByTarget: new Map(),
        incomingRefsBySection: new Map(),
      };
    });

    afterEach(() => {
      rmDirBestEffort(tempDir);
    });

    // @lat: [[fork-grounding-eval#Fork Grounding Eval#Naive preflight check produces false positives on code refs and tooling]]
    it('produces false positives in naive check on code-ref grounded files and tooling files', () => {
      const cat2Prompt = LABELED_PREFLIGHT_CORPUS[4].prompt;
      const naiveCat2 = naiveCheck(mockProject, cat2Prompt);
      expect(naiveCat2).toContain('src/auth/session.ts');

      const cat4Prompt = LABELED_PREFLIGHT_CORPUS[12].prompt;
      const naiveCat4 = naiveCheck(mockProject, cat4Prompt);
      expect(naiveCat4).toContain('vitest.config.ts');
    });

    // @lat: [[fork-grounding-eval#Fork Grounding Eval#Fork preflight achieves perfect precision on labeled prompt corpus]]
    it('achieves 100% precision on labeled prompt corpus', async () => {
      let truePositives = 0;
      let falsePositives = 0;

      for (const item of LABELED_PREFLIGHT_CORPUS) {
        const detected = await findUngroundedPromptFiles(mockProject, item.prompt);
        const expectedSet = new Set(item.expected);
        for (const p of detected) {
          if (expectedSet.has(p)) {
            truePositives++;
          } else {
            falsePositives++;
          }
        }
      }

      const precision = truePositives / (truePositives + falsePositives || 1);
      expect(falsePositives).toBe(0);
      expect(precision).toBe(1.0);
    });

    // @lat: [[fork-grounding-eval#Fork Grounding Eval#Fork preflight achieves perfect recall on genuinely ungrounded files]]
    it('achieves 100% recall on ungrounded repository files', async () => {
      let truePositives = 0;
      let falseNegatives = 0;

      for (const item of LABELED_PREFLIGHT_CORPUS) {
        const detected = await findUngroundedPromptFiles(mockProject, item.prompt);
        const detectedSet = new Set(detected);
        for (const p of item.expected) {
          if (detectedSet.has(p)) {
            truePositives++;
          } else {
            falseNegatives++;
          }
        }
      }

      const recall = truePositives / (truePositives + falseNegatives || 1);
      expect(falseNegatives).toBe(0);
      expect(recall).toBe(1.0);
    });

    // @lat: [[fork-grounding-eval#Fork Grounding Eval#Coverage gap notice directs code ref and symbol link remediation]]
    it('instructs linking via @lat: or [[file#symbol]] rather than prose documents', () => {
      expect(formatCoverageGapNotice([])).toBeNull();

      const notice = formatCoverageGapNotice(['src/billing/stripe.ts']);
      expect(notice).not.toBeNull();
      expect(notice).toContain('src/billing/stripe.ts');
      expect(notice).toContain('// @lat: [[section]]');
      expect(notice).toContain('[[file#symbol]]');
      expect(notice).toContain('do not create a separate prose section per file');
      expect(notice).not.toContain('\u2014');
      expect(notice).not.toContain('\u2013');
    });
  });

  describe('Suite 3: Stop-Hook Diff-to-Section Recall Corpus', () => {
    // @lat: [[fork-grounding-eval#Fork Grounding Eval#Naive diff matcher misses deep hunks and misattributes deletions]]
    it('misses deep-function hunks or misattributes deletions in naive 15-line matcher', () => {
      const f2 = DIFF_CORPUS[1];
      const naiveF2 = naiveDiffToSections(
        f2.diffText,
        makeMockDiffProject('/repo', f2.wikiRefs, f2.sectionIds),
        { refs: f2.codeRefs },
      );
      expect(naiveF2).toEqual([]);

      const f4 = DIFF_CORPUS[3];
      const naiveF4 = naiveDiffToSections(
        f4.diffText,
        makeMockDiffProject('/repo', f4.wikiRefs, f4.sectionIds),
        { refs: f4.codeRefs },
      );
      expect(naiveF4).toEqual([]);

      const f5 = DIFF_CORPUS[4];
      const naiveF5 = naiveDiffToSections(
        f5.diffText,
        makeMockDiffProject('/repo', f5.wikiRefs, f5.sectionIds),
        { refs: f5.codeRefs },
      );
      expect(naiveF5.length).toBeGreaterThan(0);

      const f6 = DIFF_CORPUS[5];
      const naiveF6 = naiveDiffToSections(
        f6.diffText,
        makeMockDiffProject('/repo', f6.wikiRefs, f6.sectionIds),
        { refs: f6.codeRefs },
      );
      expect(naiveF6).toContain('trash#DeadCode#Old');
    });

    // @lat: [[fork-grounding-eval#Fork Grounding Eval#Fork diff impact achieves perfect recall across all diff fixture categories]]
    it('achieves 100% recall against expected governing sections across all diff fixtures', async () => {
      for (const fixture of DIFF_CORPUS) {
        const project = makeMockDiffProject('/repo', fixture.wikiRefs, fixture.sectionIds);
        const run = makeMockCheckRun(project, fixture.codeRefs);
        const ranges = parseUnifiedZeroDiff(fixture.diffText);
        const actual = await findImpactedSectionsForDiff('/repo', run, ranges);

        const actualSet = new Set(actual);
        for (const expected of fixture.expectedSections) {
          expect(
            actualSet.has(expected),
            `Fixture ${fixture.id} should recall ${expected}`,
          ).toBe(true);
        }
      }
    });

    // @lat: [[fork-grounding-eval#Fork Grounding Eval#Fork diff impact achieves perfect precision with zero spurious sections]]
    it('achieves 100% precision against expected governing sections across all diff fixtures', async () => {
      for (const fixture of DIFF_CORPUS) {
        const project = makeMockDiffProject('/repo', fixture.wikiRefs, fixture.sectionIds);
        const run = makeMockCheckRun(project, fixture.codeRefs);
        const ranges = parseUnifiedZeroDiff(fixture.diffText);
        const actual = await findImpactedSectionsForDiff('/repo', run, ranges);

        expect(
          actual,
          `Fixture ${fixture.id} precision mismatch`,
        ).toEqual(fixture.expectedSections);
      }
    });
  });

  describe('Suite 4: MCP Workflow & Backlink Edge-Role Evaluation', () => {
    let client: Client;

    beforeAll(async () => {
      const transport = new StdioClientTransport({
        command: 'node',
        args: [cliPath, 'mcp'],
        cwd: join(casesDir, 'basic-project'),
      });
      client = new Client({ name: 'eval-client', version: '1.0' });
      await client.connect(transport);
    });

    afterAll(async () => {
      await client.close();
    });

    // @lat: [[fork-grounding-eval#Fork Grounding Eval#MCP tool descriptions enforce sequential workflow guidance]]
    it('sequences discovery tools, section reader, and post-edit validator in MCP registry', async () => {
      const { tools } = await client.listTools();
      expect(tools.length).toBe(8);
      const toolsByName = new Map(tools.map((t) => [t.name, t]));

      const searchTool = toolsByName.get('lat_search')!;
      expect(searchTool.description).toMatch(/^Start here for natural-language/i);
      expect(searchTool.description).toContain('without loading whole files');

      const locateTool = toolsByName.get('lat_locate')!;
      expect(locateTool.description).toMatch(/^Start here when part of a section heading or slug is known/i);
      expect(locateTool.description).toContain('without reading files');

      const sectionTool = toolsByName.get('lat_section')!;
      expect(sectionTool.description).toMatch(/Call after lat_search or lat_locate/i);
      expect(sectionTool.description).toContain('Prefer this over reading raw markdown files');

      const checkTool = toolsByName.get('lat_check')!;
      expect(checkTool.description).toMatch(/Run after editing code or lat\.md\/ files to validate/i);
    });

    // @lat: [[fork-grounding-eval#Fork Grounding Eval#MCP tool descriptions contain zero em dashes and zero en dashes]]
    it('contains zero Unicode em dashes and zero en dashes in MCP tool descriptions', async () => {
      const { tools } = await client.listTools();
      for (const tool of tools) {
        expect(typeof tool.description).toBe('string');
        expect(tool.description!).not.toContain('\u2014');
        expect(tool.description!).not.toContain('\u2013');
        expect(tool.description!.endsWith('.')).toBe(true);
      }
    });

    // @lat: [[fork-grounding-eval#Fork Grounding Eval#Section output formats exact backlink coordinates with role badges]]
    it('preserves leading paragraph and attaches exact coordinates and badges to incoming references', () => {
      const fullLeadingPara =
        'The token validator enforces cryptographic signatures and expiration windows before processing incoming requests.';
      const ctx: CmdContext = {
        latDir: join(process.cwd(), 'lat.md'),
        projectRoot: process.cwd(),
        styler: plainStyler,
        mode: 'cli',
      };

      const found: SectionFound = {
        kind: 'found',
        section: {
          id: 'auth#Authentication#Token Validation',
          heading: 'Token Validation',
          depth: 2,
          file: 'lat.md/auth.md',
          filePath: 'lat.md/auth.md',
          children: [],
          startLine: 10,
          endLine: 25,
          firstParagraph: fullLeadingPara,
        },
        content: `# Token Validation\n\n${fullLeadingPara}\n\nTokens expiring within 60 seconds are rejected immediately.`,
        status: null,
        outgoingRefs: [],
        outgoingSourceRefs: [],
        outgoingExternalRefs: [],
        incomingRefs: [
          {
            section: {
              id: 'api#API#Auth Endpoint',
              heading: 'Auth Endpoint',
              depth: 2,
              file: 'lat.md/api.md',
              filePath: 'lat.md/api.md',
              children: [],
              startLine: 1,
              endLine: 10,
              firstParagraph: 'The auth endpoint routes login requests.',
            },
            reason: 'wiki link',
            citeFile: 'lat.md/api.md',
            citeLine: 14,
          },
        ],
        codeRefs: [
          {
            file: 'tests/auth/token.test.ts',
            line: 42,
            snippet: '// @lat: [[auth#Authentication#Token Validation]]',
          },
          {
            file: 'src/auth/token.ts',
            line: 15,
            snippet: '// @lat: [[auth#Authentication#Token Validation]]',
          },
        ],
      };

      const formatted = formatSectionOutput(ctx, found);

      expect(formatted).toContain(`> ${fullLeadingPara}`);
      expect(formatted).toContain('[[api#API#Auth Endpoint]] (lat.md/api.md:14)');
      expect(formatted).toContain('tests/auth/token.test.ts:42 [test]');
      expect(formatted).toContain('src/auth/token.ts:15 [code]');
    });

    // @lat: [[fork-grounding-eval#Fork Grounding Eval#Knowledge graph export classifies all edge semantic roles]]
    it('assigns exact semantic roles across all graph edge types', async () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'lat-eval-graph-'));
      try {
        mkdirSync(join(tempDir, 'lat.md', 'tests'), { recursive: true });
        mkdirSync(join(tempDir, 'src'), { recursive: true });
        mkdirSync(join(tempDir, 'tests'), { recursive: true });

        const files: GraphSourceFile[] = [
          {
            relPath: 'lat.md/guide.md',
            content: `# Guide\n\nOverview.\n\nSee [[helper#Helper#HelperSection]], [[src/app.ts#runApp]], and [[tests/auth-spec#Auth Spec#TokenVerification]].\n`,
          },
          {
            relPath: 'lat.md/helper.md',
            content: `# Helper\n\nHelper doc.\n\n## HelperSection\n\nHelper section details.\n`,
          },
          {
            relPath: 'lat.md/tests/auth-spec.md',
            content: `---\nlat:\n  require-code-mention: true\n---\n# Auth Spec\n\nSpec overview.\n\n## TokenVerification\n\nToken verification spec.\n`,
          },
        ];

        writeFileSync(
          join(tempDir, 'src', 'app.ts'),
          '// @lat: [[guide#Guide]]\nexport function runApp() {}\n',
        );
        writeFileSync(
          join(tempDir, 'tests', 'app.test.ts'),
          '// @lat: [[guide#Guide]]\nexport function testApp() {}\n',
        );
        writeFileSync(
          join(tempDir, 'tests', 'auth.test.ts'),
          '// @lat: [[tests/auth-spec#Auth Spec#TokenVerification]]\nexport function testAuth() {}\n',
        );

        const graph = await buildGraph(files, tempDir, true);

        const sectionRefEdge = graph.edges.find(
          (e) => e.type === 'wikilink' && e.role === 'section-ref',
        );
        expect(sectionRefEdge).toBeDefined();
        expect(sectionRefEdge?.to).toBe('section:lat.md/helper#Helper#HelperSection');

        const symbolRefEdge = graph.edges.find(
          (e) => e.type === 'wikilink' && e.role === 'symbol-ref',
        );
        expect(symbolRefEdge).toBeDefined();
        expect(symbolRefEdge?.to).toBe('code:src/app.ts#runApp');

        const testSpecRefEdge = graph.edges.find(
          (e) => e.type === 'wikilink' && e.role === 'test-spec-ref',
        );
        expect(testSpecRefEdge).toBeDefined();
        expect(testSpecRefEdge?.to).toBe(
          'section:lat.md/tests/auth-spec#Auth Spec#TokenVerification',
        );

        const implementsEdge = graph.edges.find(
          (e) => e.type === 'code-ref' && e.role === 'implements',
        );
        expect(implementsEdge).toBeDefined();
        expect(implementsEdge?.from).toBe('code:src/app.ts:1');

        const testCodeEdge = graph.edges.find(
          (e) =>
            e.type === 'code-ref' &&
            e.role === 'verifies' &&
            e.from === 'code:tests/app.test.ts:1',
        );
        expect(testCodeEdge).toBeDefined();

        const testSpecEdge = graph.edges.find(
          (e) =>
            e.type === 'code-ref' &&
            e.role === 'verifies' &&
            e.from === 'code:tests/auth.test.ts:1',
        );
        expect(testSpecEdge).toBeDefined();

        const containsEdges = graph.edges.filter((e) => e.type === 'contains');
        expect(containsEdges.length).toBeGreaterThan(0);
        for (const e of containsEdges) {
          expect(e.role).toBeUndefined();
        }

        const jsonStr = formatGraphJson(graph);
        const parsed = JSON.parse(jsonStr);
        for (const e of parsed.edges.filter(
          (edge: any) => edge.type === 'contains',
        )) {
          expect(e).not.toHaveProperty('role');
        }
      } finally {
        rmDirBestEffort(tempDir);
      }
    });
  });
});
