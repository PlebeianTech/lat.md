import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { join, relative } from 'node:path';
import { toPosix, walkEntries } from './walk.js';

/** Glob patterns used to exclude directories/files from code-ref scanning.
 *  Shared between rg args and the TS fallback's walkFiles filter. */
const EXCLUDE_DIRS = ['lat.md', '.claude'];
const EXCLUDE_GLOBS = ['*.md'];

/** Walk project files for code-ref scanning. Uses walkEntries for .gitignore
 *  support, then additionally skips .md files, lat.md/, .claude/, and sub-projects. */
export async function walkFiles(dir: string): Promise<string[]> {
  const entries = await walkEntries(dir);

  // Collect directories that contain their own lat.md/ (sub-projects)
  const subProjects = new Set<string>();
  for (const e of entries) {
    const i = e.indexOf('/lat.md/');
    if (i !== -1) subProjects.add(e.slice(0, i + 1));
  }

  return entries
    .filter(
      (e) =>
        !e.endsWith('.md') &&
        !e.startsWith('lat.md/') &&
        !e.startsWith('.claude/') &&
        ![...subProjects].some((prefix) => e.startsWith(prefix)),
    )
    .map((e) => join(dir, e));
}

/** Build a RegExp from a verbose template — whitespace is insignificant. */
function re(flags: string) {
  return (strings: TemplateStringsArray) =>
    new RegExp(strings.raw[0].replace(/\s+/g, ''), flags);
}

// Line comment (// or #), then @lat: marker, then [[target]]
export const LAT_REF_RE = re('gv')`
  (?: // | # )
  \s* @lat: \s*
  \[\[
    ( [^\]]+ )
  \]\]
`;

/** Explicit opt-out: a standalone `lat:ignore` token anywhere on the line
 *  suppresses any @lat: match on that line. This gives an author documenting
 *  the syntax one obvious escape hatch when a match isn't inside a
 *  quoted/backticked literal (the common case handled by
 *  `isInsideQuotedSpan`). Word-boundary lookarounds (rather than `\b`, which
 *  treats `:` as a boundary on both sides already and wouldn't help) keep
 *  incidental substrings — `lat:ignore-config`, `mylat:ignore` — from
 *  suppressing a real ref on the same line, while still matching the token
 *  at the very start of a line or glued directly to a comment marker
 *  (`//lat:ignore`), since `/` isn't a word character either. */
const LAT_IGNORE_RE = /(?<![\w])lat:ignore(?![-\w])/;

/** Quote characters treated as delimiting a literal span: plain strings
 *  ('...' or "...") and backtick spans, which double as inline-code markers
 *  when a comment is documenting the @lat: syntax itself (e.g. `` `@lat:
 *  [[section-id]]` ``). A marker whose match falls inside such a span is an
 *  example, not a real reference, so it is not returned as a ref. */
const QUOTE_CHARS = ['"', '`', "'"] as const;

/**
 * Returns true if `index` (an offset into `line`) falls inside a
 * quote-delimited span on that line. For each quote character, occurrences
 * are paired up in order (open, close, open, close, ...); if a quote
 * character appears an odd number of times on the line, it's ambiguous
 * (e.g. an apostrophe in prose) and is ignored entirely for that line rather
 * than risk hiding a real reference.
 */
function isInsideQuotedSpan(line: string, index: number): boolean {
  for (const q of QUOTE_CHARS) {
    const positions: number[] = [];
    for (let i = 0; i < line.length; i++) {
      if (line[i] === q && line[i - 1] !== '\\') positions.push(i);
    }
    if (positions.length < 2 || positions.length % 2 !== 0) continue;
    for (let i = 0; i < positions.length; i += 2) {
      if (index > positions[i] && index < positions[i + 1]) return true;
    }
  }
  return false;
}

/** Filter regex matches on a single line, dropping ones that are inside a
 *  quoted/backticked literal or on a line carrying an explicit `lat:ignore`
 *  opt-out — these document the @lat: syntax rather than using it. */
function extractRefsFromLine(line: string): string[] {
  if (LAT_IGNORE_RE.test(line)) return [];
  const targets: string[] = [];
  LAT_REF_RE.lastIndex = 0;
  let match;
  while ((match = LAT_REF_RE.exec(line)) !== null) {
    if (!isInsideQuotedSpan(line, match.index)) {
      targets.push(match[1]);
    }
  }
  return targets;
}

export type CodeRef = {
  target: string;
  file: string;
  line: number;
};

export type ScanResult = {
  refs: CodeRef[];
  files: string[];
  usedRg: boolean;
};

/**
 * Run an external command and return stdout, or null if the command is not found
 * or fails.
 */
function tryExec(
  cmd: string,
  args: string[],
  cwd: string,
): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, maxBuffer: 50 * 1024 * 1024 }, (err, out) => {
      if (err) {
        // Exit code 1 with no stderr typically means "no matches" for grep/rg
        const exitCode = (
          err as NodeJS.ErrnoException & { code?: string | number }
        ).code;
        if (exitCode === 'ENOENT') {
          resolve(null); // command not found
          return;
        }
        // rg/grep exit 1 = no matches (not an error)
        if (
          'status' in err &&
          (err as { status?: number }).status === 1 &&
          out === ''
        ) {
          resolve('');
          return;
        }
        resolve(null);
        return;
      }
      resolve(out);
    });
  });
}

/**
 * Detect sub-projects (directories containing their own lat.md/) using
 * rg --files. Finds files inside nested lat.md/ dirs and extracts the parent
 * directory paths. Returns paths relative to projectRoot.
 */
async function findSubProjects(projectRoot: string): Promise<string[]> {
  // List files inside any lat.md/ dir, then extract unique parent paths.
  // The root lat.md/ is excluded by EXCLUDE_DIRS in the caller, so we only
  // need to find nested ones here — search for files under */lat.md/.
  const out = await tryExec(
    'rg',
    ['--files', '--glob', '**/lat.md/**', '.'],
    projectRoot,
  );
  if (!out) return [];

  const subProjects = new Set<string>();
  for (const rawLine of out.split('\n')) {
    if (!rawLine) continue;
    // rg emits native separators on Windows; normalize before matching '/lat.md/'.
    const line = toPosix(rawLine);
    const clean = line.startsWith('./') ? line.slice(2) : line;
    // "tests/cases/foo/lat.md/specs.md" → "tests/cases/foo"
    // Skip root lat.md/ (no parent prefix — starts with "lat.md/")
    const idx = clean.indexOf('/lat.md/');
    if (idx !== -1) subProjects.add(clean.slice(0, idx));
  }
  return [...subProjects];
}

/** Build rg glob exclusion args. */
function rgExcludeArgs(subProjects: string[]): string[] {
  const args: string[] = [];
  for (const dir of EXCLUDE_DIRS) args.push('--glob', `!${dir}/`);
  for (const glob of EXCLUDE_GLOBS) args.push('--glob', `!${glob}`);
  for (const sp of subProjects) args.push('--glob', `!${sp}/`);
  return args;
}

/**
 * Try scanning with ripgrep. Returns parsed refs and scanned file list, or null
 * if rg is not available. rg respects .gitignore by default; we add glob
 * exclusions for lat.md/, .claude/, *.md files, and sub-projects.
 */
async function tryRipgrep(
  projectRoot: string,
): Promise<{ refs: CodeRef[]; files: string[] } | null> {
  // Detect sub-projects first so we can exclude them from all rg calls
  const subProjects = await findSubProjects(projectRoot);
  const excludes = rgExcludeArgs(subProjects);

  // Search for @lat refs
  const searchArgs = [
    '--no-heading',
    '--line-number',
    '--with-filename',
    ...excludes,
    '@lat:.*\\[\\[',
    '.',
  ];
  const out = await tryExec('rg', searchArgs, projectRoot);
  if (out === null) return null;

  const { refs } = parseGrepOutput(out);

  // List all scanned files (for stats) — rg --files is fast
  const filesOut = await tryExec(
    'rg',
    ['--files', ...excludes, '.'],
    projectRoot,
  );
  const files = (filesOut || '')
    .split('\n')
    .filter(Boolean)
    .map((f) => {
      const clean = toPosix(f).replace(/^\.\//, '');
      return join(projectRoot, clean);
    });

  return { refs, files };
}

/**
 * Parse rg output lines (file:line:content) into CodeRef entries.
 */
function parseGrepOutput(output: string): { refs: CodeRef[] } {
  const refs: CodeRef[] = [];

  if (!output.trim()) return { refs };

  for (const line of output.split('\n')) {
    if (!line) continue;
    // Format: ./path/to/file:linenum:content
    const firstColon = line.indexOf(':');
    if (firstColon === -1) continue;
    const secondColon = line.indexOf(':', firstColon + 1);
    if (secondColon === -1) continue;

    // rg emits native separators (`\` on Windows); normalize to POSIX so the
    // stored path matches wiki-link and TS-fallback conventions. This also
    // turns a Windows `.\` prefix into `./` for the strip below.
    let filePath = toPosix(line.slice(0, firstColon));
    const lineNum = parseInt(line.slice(firstColon + 1, secondColon), 10);
    const content = line.slice(secondColon + 1);

    if (isNaN(lineNum)) continue;

    // Strip leading ./ from path
    if (filePath.startsWith('./')) filePath = filePath.slice(2);

    // Extract targets using the same regex and literal-span filtering as the
    // TS fallback, so both scan paths agree regardless of whether ripgrep is
    // installed.
    for (const target of extractRefsFromLine(content)) {
      refs.push({ target, file: filePath, line: lineNum });
    }
  }

  return { refs };
}

/**
 * TypeScript fallback: read every file and scan for @lat refs.
 */
async function scanWithTs(
  files: string[],
  projectRoot: string,
): Promise<CodeRef[]> {
  const refs: CodeRef[] = [];

  for (const file of files) {
    let content: string;
    try {
      content = await readFile(file, 'utf-8');
    } catch (err) {
      process.stderr.write(
        `Error: failed to read ${file}: ${(err as Error).message}\n`,
      );
      continue;
    }
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      for (const target of extractRefsFromLine(lines[i])) {
        refs.push({
          target,
          file: toPosix(relative(projectRoot, file)),
          line: i + 1,
        });
      }
    }
  }

  return refs;
}

/** Check whether ripgrep (`rg`) is available on PATH. */
export async function hasRipgrep(): Promise<boolean> {
  const result = await tryExec('rg', ['--version'], '.');
  return result !== null;
}

export async function scanCodeRefs(projectRoot: string): Promise<ScanResult> {
  // Fast path: use rg for both searching and file listing
  // _LAT_DISABLE_RG is a test-only escape hatch to force the TS fallback
  if (process.env._LAT_DISABLE_RG !== '1') {
    const rgResult = await tryRipgrep(projectRoot);
    if (rgResult !== null) {
      return { refs: rgResult.refs, files: rgResult.files, usedRg: true };
    }
  }

  // Fallback: walk files ourselves and scan with TS
  const files = await walkFiles(projectRoot);
  const refs = await scanWithTs(files, projectRoot);
  return { refs, files, usedRg: false };
}
