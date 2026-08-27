import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
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

/** Prepend the `require-mode` flag to a root index that has no frontmatter. */
export function stampRequireMode(content: string): string {
  if (/^---\n/.test(content)) return content;
  return `---\nlat:\n  require-mode: true\n---\n\n${content.replace(/^\n+/, '')}`;
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
