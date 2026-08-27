import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { listLatticeFiles, parseFrontmatter } from '../lattice.js';
import { basename, join, relative, sep } from 'node:path';
import { styleText } from 'node:util';
import { DIATAXIS_MODES, MODE_DIRS, indexNameFor } from './check-mode.js';

/**
 * Give a freshly created `lat.md/` the Diátaxis shape, and turn the gate on.
 *
 * Upstream's `templates/init/` holds two files and is copied wholesale, so a
 * new tree is one flat root index. An agent asked to document a codebase then
 * writes flat files beside it — which is not merely untidy: `checkMode` binds
 * only inside the four mode directories, so flat placement puts every document
 * out of reach of every shape rule. A bella-derms session did exactly that and
 * confirmed afterwards that its largest document produced 64 errors the moment
 * it was moved into `reference/`.
 *
 * Structure is the cheaper half of the fix. Four directories that already
 * exist, each with a passing index, make placement the path of least
 * resistance; `require-mode: true` in the root index makes flat placement an
 * error rather than an option.
 *
 * Written from here rather than added to `templates/init/` because the flag
 * has to land inside `lat.md/lat.md`, which upstream's template owns.
 */

/** One-line summary and body for each mode's index, keyed by directory. */
const MODE_INDEX: Record<string, { title: string; lead: string }> = {
  tutorials: {
    title: 'Tutorials',
    lead: 'Guided first passes through this system, each ending somewhere the reader can see.',
  },
  'how-to': {
    title: 'How-to',
    lead: 'Recipes for tasks that recur, written for someone who already knows what they want.',
  },
  reference: {
    title: 'Reference',
    lead: 'Lookup facts about this system: fields, states, limits, names and defaults.',
  },
  explanation: {
    title: 'Explanation',
    lead: 'Why this system is shaped the way it is, and what the alternatives cost.',
  },
};

/**
 * A mode index has to satisfy its own mode. A tutorial index needs ordered
 * steps and a stated outcome, a how-to index needs ordered steps, and a
 * reference index must not carry a second paragraph — so each stub is written
 * to the rule it will be checked against rather than to one house style.
 */
function indexBody(dir: string): string {
  const { title, lead } = MODE_INDEX[dir];
  const header = `# ${title}\n\n${lead}\n`;

  if (dir === 'tutorials') {
    return (
      header +
      '\nBy the end of any document here the reader will have run something and seen it work.\n' +
      '\n1. Pick the tutorial closest to what you are trying to learn.\n' +
      '2. Follow it top to bottom without skipping.\n' +
      '3. Come back to `reference/` for the details it left out.\n'
    );
  }

  if (dir === 'how-to') {
    return (
      header +
      '\n1. Find the recipe for the task in front of you.\n' +
      '2. Follow its steps.\n' +
      '3. If no recipe fits, write one here once the task is done.\n'
    );
  }

  if (dir === 'reference') {
    return header;
  }

  return (
    header +
    '\nEach document here answers a "why", not a "how". The steps that follow ' +
    'from a decision belong in `how-to/`, and the facts it fixes belong in ' +
    '`reference/`.\n'
  );
}

/**
 * Turn the gate on in a root index, whatever frontmatter it already has.
 *
 * Bailing on any existing frontmatter — the first version of this — produced a
 * silent no-op: a root index carrying `lat: tags: [...]` could never opt in,
 * and `lat init` re-offered on every run because the flag it had just written
 * was not there. Merging is what makes the offer terminate.
 *
 * Edited line by line rather than parsed and re-emitted, because re-emitting
 * reformats the whole block and discards its comments. The one shape that
 * cannot be edited safely — `lat:` carrying a flow mapping on its own line —
 * is returned unchanged, and the caller falls back to printing the edit.
 */
export function stampRequireMode(content: string): string {
  const fence = content.match(/^---\n([\s\S]*?)\n---[ \t]*(\r?\n|$)/);
  if (!fence) {
    return `---\nlat:\n  require-mode: true\n---\n\n${content.replace(/^\n+/, '')}`;
  }

  const body = fence[1];
  if (/^\s*require-mode\s*:/m.test(body)) return content;

  const lines = body.split('\n');
  const latAt = lines.findIndex((line) => /^lat\s*:/.test(line));

  let merged: string[];
  if (latAt === -1) {
    merged = [...lines, 'lat:', '  require-mode: true'];
  } else if (lines[latAt].replace(/^lat\s*:/, '').trim() !== '') {
    // `lat: {mode: reference}` or `lat: &anchor` — a line-based insert would
    // corrupt it, so say nothing and let the caller print the edit.
    return content;
  } else {
    // Siblings must share indentation, so take it from the existing first
    // child rather than assuming two spaces.
    const child = lines
      .slice(latAt + 1)
      .find((line) => line.trim() !== '' && /^\s/.test(line));
    const indent = child ? (child.match(/^\s+/)?.[0] ?? '  ') : '  ';
    merged = [
      ...lines.slice(0, latAt + 1),
      `${indent}require-mode: true`,
      ...lines.slice(latAt + 1),
    ];
  }

  const end = fence[0].length;
  return `---\n${merged.join('\n')}\n---${fence[2] || '\n'}${content.slice(end)}`;
}

/** Whether the gate is on, read straight from a root index's frontmatter. */
export function requireModeSet(content: string): boolean {
  return parseFrontmatter(content).raw['require-mode'] !== undefined;
}

/**
 * Append the four mode directories to the root index.
 *
 * Without this a fresh `lat init` leaves `lat check index` reporting four
 * missing entries, which is a poor first impression of a tool whose whole
 * pitch is that the check passes.
 */
export function listModeDirs(content: string): string {
  const entries = DIATAXIS_MODES.map((mode) => {
    const dir = MODE_DIRS[mode];
    const { title, lead } = MODE_INDEX[dir];
    return `- [${title}](${dir}/${dir}.md) — ${lead}`;
  }).join('\n');

  if (content.includes(`(${MODE_DIRS.reference}/`)) return content;

  let base = content;
  if (!base.endsWith('\n')) base += '\n';
  return `${base}\nEvery document belongs in exactly one of these.\n\n${entries}\n`;
}

/**
 * Scaffold the four mode directories and turn the gate on. Called only on the
 * run that creates `lat.md/`, so an existing tree is never restructured
 * underneath its owner.
 */
export function writeForkScaffold(latDir: string): void {
  const created: string[] = [];

  for (const mode of DIATAXIS_MODES) {
    const dir = MODE_DIRS[mode];
    const dirPath = join(latDir, dir);
    const indexPath = join(dirPath, `${dir}.md`);
    if (existsSync(indexPath)) continue;
    mkdirSync(dirPath, { recursive: true });
    writeFileSync(indexPath, indexBody(dir));
    created.push(`${dir}/`);
  }

  const rootIndex = join(latDir, indexNameFor(basename(latDir)));
  if (existsSync(rootIndex)) {
    const current = readFileSync(rootIndex, 'utf-8');
    const stamped = listModeDirs(stampRequireMode(current));
    if (stamped !== current) writeFileSync(rootIndex, stamped);
  }

  if (created.length > 0) {
    console.log(
      styleText('green', 'Scaffolded Diátaxis modes') +
        ' — ' +
        created.join(' ') +
        styleText('dim', ' (every document belongs in one of these)'),
    );
  }
}

// ── Adopting the gate in a tree that already exists ──────────────────

/**
 * Where a declined offer is remembered.
 *
 * Fork-owned rather than a field on upstream's `lat_init.json`, so recording
 * it costs no edit to `src/init-version.ts`. `lat.md/.cache/` is already in
 * the scaffolded `.gitignore`, so the marker stays out of the repository.
 */
function declinePath(latDir: string): string {
  return join(latDir, '.cache', 'lat_fork.json');
}

function declined(latDir: string): boolean {
  try {
    const raw: unknown = JSON.parse(readFileSync(declinePath(latDir), 'utf-8'));
    return (
      typeof raw === 'object' &&
      raw !== null &&
      (raw as Record<string, unknown>)['require_mode_declined'] === true
    );
  } catch {
    return false;
  }
}

function recordDecline(latDir: string): void {
  mkdirSync(join(latDir, '.cache'), { recursive: true });
  writeFileSync(
    declinePath(latDir),
    JSON.stringify({ require_mode_declined: true }, null, 2) + '\n',
  );
}

/** Documents the gate would reject today: not an index, no mode either way. */
async function unmodedDocuments(latDir: string): Promise<string[]> {
  const modeDirs = new Set<string>(
    DIATAXIS_MODES.map((mode) => MODE_DIRS[mode]),
  );
  const files = await listLatticeFiles(latDir);
  const offenders: string[] = [];

  for (const file of files) {
    const rel = relative(latDir, file).split(sep).join('/');
    const segments = rel.split('/');
    const fileName = segments.pop()!;
    const holder = segments.length === 0 ? basename(latDir) : segments.at(-1)!;
    if (fileName === indexNameFor(holder)) continue;
    if (segments.length > 0 && modeDirs.has(segments[0])) continue;
    const declaredMode = parseFrontmatter(readFileSync(file, 'utf-8')).raw[
      'mode'
    ];
    if (typeof declaredMode === 'string') continue;
    offenders.push(rel);
  }
  return offenders;
}

/**
 * Offer the gate to a tree `lat init` did not create.
 *
 * `writeForkScaffold` runs only on the branch that creates `lat.md/`, which
 * left the flag unreachable for every project that already had one — that is,
 * for every project that needs it. Restructuring someone's tree without asking
 * is still wrong, so this asks.
 *
 * Silent when the flag is already set, when a previous run was told no, and
 * when there is no TTY to ask — the non-interactive path prints the count and
 * the manual edit instead, and records nothing, so a later interactive run
 * still offers.
 */
export async function offerRequireMode(
  latDir: string,
  interactive: boolean,
  ask: (message: string) => Promise<boolean>,
): Promise<void> {
  const rootIndex = join(latDir, indexNameFor(basename(latDir)));
  if (!existsSync(rootIndex)) return;
  if (requireModeSet(readFileSync(rootIndex, 'utf-8'))) return;
  if (declined(latDir)) return;

  const offenders = await unmodedDocuments(latDir);

  console.log('');
  console.log(styleText('bold', 'Diátaxis modes'));
  console.log(
    '  ' +
      styleText('dim', 'Every document belongs in one of four modes. Without') +
      ' require-mode ' +
      styleText('dim', 'a document'),
  );
  console.log(
    '  ' +
      styleText(
        'dim',
        'placed outside a mode directory is checked against no shape rule at all.',
      ),
  );

  if (offenders.length > 0) {
    console.log('');
    console.log(
      `  ${styleText('yellow', String(offenders.length))} document(s) would need a mode:`,
    );
    for (const name of offenders.slice(0, 5)) {
      console.log('    ' + styleText('dim', name));
    }
    if (offenders.length > 5) {
      console.log(
        '    ' + styleText('dim', `... and ${offenders.length - 5} more`),
      );
    }
  }

  if (!interactive) {
    console.log('');
    console.log(
      '  ' +
        styleText('dim', 'To turn it on, add this to the top of') +
        ` ${basename(latDir)}/${indexNameFor(basename(latDir))}:`,
    );
    console.log('');
    for (const line of ['---', 'lat:', '  require-mode: true', '---']) {
      console.log('    ' + styleText('cyan', line));
    }
    return;
  }

  console.log('');
  if (!(await ask('  Turn require-mode on for this project?'))) {
    recordDecline(latDir);
    console.log(
      '  ' +
        styleText('dim', 'Skipped. Add') +
        ' require-mode: true ' +
        styleText('dim', 'to the root index whenever you want it.'),
    );
    return;
  }

  writeForkScaffold(latDir);

  // The one frontmatter shape `stampRequireMode` refuses to edit. Saying so
  // beats re-offering forever on a flag that never lands.
  if (!requireModeSet(readFileSync(rootIndex, 'utf-8'))) {
    console.log(
      '  ' +
        styleText('yellow', 'Could not edit the frontmatter safely.') +
        styleText('dim', ' Add this under its `lat:` mapping by hand:'),
    );
    console.log('    ' + styleText('cyan', 'require-mode: true'));
    return;
  }

  if (offenders.length > 0) {
    console.log(
      '  ' +
        styleText('dim', 'Run') +
        ' lat check ' +
        styleText('dim', 'to see which documents need placing.'),
    );
  }
}
