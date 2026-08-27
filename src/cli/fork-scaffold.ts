import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { styleText } from 'node:util';
import { isMap, isScalar, isSeq, parseDocument } from 'yaml';
import { parseFrontmatter } from '../lattice.js';
import type { CheckError } from './check.js';
import {
  DIATAXIS_MODES,
  MODE_DIRS,
  checkMode,
  indexNameFor,
} from './check-mode.js';

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

// ── Turning the gate on in a root index ──────────────────────────────

/**
 * The frontmatter fence, copied from `parseFrontmatter` rather than written
 * afresh.
 *
 * The two readers have to agree on what counts as frontmatter. When they did
 * not — this pattern once required the closing fence to end its line, which
 * upstream's does not — a root index closed with `----` was frontmatter to the
 * parser and no frontmatter here, so a whole second block was prepended above
 * the real one. The original block still sat in the file, still looked live,
 * and every field it declared was silently no longer read.
 */
const FENCE = /^---\n([\s\S]*?)\n---/;

/**
 * `lineWidth: 0` stops long values being wrapped onto continuation lines, and
 * `flowCollectionPadding: false` keeps `[a, b]` from becoming `[ a, b ]`. Both
 * exist to keep the diff to the line that changed.
 */
const STRINGIFY = { flowCollectionPadding: false, lineWidth: 0 } as const;

/** What the root index says about the gate today. */
export type RequireModeState = 'on' | 'off' | 'unset' | 'invalid';

/**
 * Read the gate straight from a root index's frontmatter.
 *
 * Four states rather than a boolean, because `checkMode` enforces on `=== true`
 * and anything looser here disagrees with it. A root index reading
 * `require-mode: yes` is a string to this parser: treating that as "set" left
 * the user believing the gate was on, `checkMode` enforcing nothing, and the
 * one prompt that would have said so permanently silenced by the same value.
 * `invalid` is reported rather than assumed either way.
 */
export function requireModeState(content: string): RequireModeState {
  const value = parseFrontmatter(content).raw['require-mode'];
  if (value === undefined) return 'unset';
  if (value === true) return 'on';
  if (value === false) return 'off';
  return 'invalid';
}

/** What `planRequireMode` decided, before anything is written or asked. */
export type StampPlan =
  /** Already `true`; nothing to do. */
  | { kind: 'on' }
  /** Explicitly `false`. A deliberate opt-out is not re-offered. */
  | { kind: 'off' }
  /** The edited document, ready to write. */
  | { kind: 'stamped'; content: string; movedRootKey: boolean }
  /** Present but neither `true` nor `false`. */
  | { kind: 'invalid'; detail: string }
  /** The frontmatter does not parse, so no field on it is read at all. */
  | { kind: 'unparseable'; detail: string }
  /** `lat:` holds something that cannot carry a mapping key. */
  | { kind: 'unsupported'; detail: string };

function shapeOf(node: unknown): string {
  if (isSeq(node)) return 'a list';
  if (isScalar(node)) return `the value ${JSON.stringify(node.value)}`;
  return 'something other than a mapping';
}

/**
 * Decide what turning the gate on in this document would do, without doing it.
 *
 * Parsed and re-emitted through the YAML document API rather than edited line
 * by line. Line surgery looked cheaper — it preserves the file byte for byte
 * except where it inserts — but it has to answer, from raw text, every question
 * the parser already answers: which line opens the block, which lines are the
 * `lat:` mapping's own children rather than a later key's, how far they are
 * indented, and whether the value on the `lat:` line is a flow mapping, an
 * anchor or a block scalar. Each wrong answer was its own defect: a flow
 * mapping and an anchor were refused although both merge cleanly, an empty
 * `lat:` beside a sibling list was refused because the scan walked past the end
 * of the block, and one shape produced frontmatter that no longer parsed at
 * all. `parseDocument` answers all of it, and round-trips comments and blank
 * lines while doing so.
 *
 * The one thing the document API does not give for free is that the fields
 * already there survive, so that is asserted below rather than assumed.
 */
export function planRequireMode(content: string): StampPlan {
  const state = requireModeState(content);
  if (state === 'on') return { kind: 'on' };
  if (state === 'off') return { kind: 'off' };
  if (state === 'invalid') {
    const value = parseFrontmatter(content).raw['require-mode'];
    return {
      kind: 'invalid',
      detail: `require-mode is ${JSON.stringify(value)}; it must be true or false`,
    };
  }

  const fence = content.match(FENCE);

  // Every branch below produces `stamped` and then falls through to the same
  // gate. Returning early from any of them is how the last version let the
  // "no frontmatter here" branch write a second block above frontmatter the
  // parser was reading perfectly well.
  let stamped: string;
  let movedRootKey = false;

  if (!fence) {
    stamped = `---\nlat:\n  require-mode: true\n---\n\n${content.replace(/^\n+/, '')}`;
  } else {
    const doc = parseDocument(fence[1]);
    if (doc.errors.length > 0) {
      return {
        kind: 'unparseable',
        detail: doc.errors[0].message.split('\n')[0],
      };
    }

    const node: unknown = doc.get('lat', true);
    if (node === undefined || node === null) {
      doc.set('lat', doc.createNode({ 'require-mode': true }));
    } else if (isScalar(node) && node.value === null) {
      // `lat:` with nothing under it. Replacing the key in place keeps its
      // position and any comment attached to it.
      doc.set('lat', doc.createNode({ 'require-mode': true }));
    } else if (isMap(node)) {
      doc.setIn(['lat', 'require-mode'], true);
    } else {
      return {
        kind: 'unsupported',
        detail: `\`lat:\` holds ${shapeOf(node)}, which cannot take \`require-mode\``,
      };
    }

    // A root-level `require-mode` is dead — upstream reads fields only under
    // `lat:` — and `checkFrontmatter` reports it as misplaced. Once the nested
    // key exists that report stops firing, because the diagnostic asks whether
    // the field is missing from `lat:`. Leaving the dead key behind would mean
    // silently ending the one message that would ever have mentioned it, so it
    // is moved rather than shadowed.
    movedRootKey = doc.has('require-mode');
    if (movedRootKey) doc.delete('require-mode');

    stamped = `---\n${doc.toString(STRINGIFY)}---${content.slice(fence[0].length)}`;
  }

  // The invariant, asserted rather than argued.
  //
  // Setting the flag is worth nothing if the merge quietly drops a field that
  // was already there: an edit that lands `require-mode: true` and loses
  // `require-code-mention: true` turns one check on and another off, and `lat
  // check` then passes on a document that used to be enforced. Checking that
  // the output parses is not enough to catch it — the losing edit parses fine.
  // So every key read before must read back the same afterwards.
  const before = parseFrontmatter(content);
  const after = parseFrontmatter(stamped);
  if (
    (after.problems ?? []).some((problem) => problem.kind === 'parse-error')
  ) {
    return {
      kind: 'unsupported',
      detail: 'the merged frontmatter did not parse',
    };
  }
  if (after.raw['require-mode'] !== true) {
    return {
      kind: 'unsupported',
      detail: 'the flag did not land where it is read',
    };
  }
  for (const [key, value] of Object.entries(before.raw)) {
    if (JSON.stringify(after.raw[key]) !== JSON.stringify(value)) {
      return {
        kind: 'unsupported',
        detail: `the merge would change \`${key}\``,
      };
    }
  }

  return { kind: 'stamped', content: stamped, movedRootKey };
}

/** The edited document when the gate can be turned on, the input when not. */
export function stampRequireMode(content: string): string {
  const plan = planRequireMode(content);
  return plan.kind === 'stamped' ? plan.content : content;
}

/**
 * Append the four mode directories to the root index.
 *
 * Without this a fresh `lat init` leaves `lat check index` reporting four
 * missing entries, which is a poor first impression of a tool whose whole
 * pitch is that the check passes. Each directory is tested for separately: an
 * index that already links `reference/` used to suppress the other three, so
 * the three unlinked directories this had just created turned a passing
 * `lat check index` into a failing one.
 */
export function listModeDirs(content: string): string {
  const missing = DIATAXIS_MODES.map((mode) => MODE_DIRS[mode]).filter(
    (dir) => !content.includes(`(${dir}/`),
  );
  if (missing.length === 0) return content;

  const entries = missing
    .map((dir) => {
      const { title, lead } = MODE_INDEX[dir];
      return `- [${title}](${dir}/${dir}.md) — ${lead}`;
    })
    .join('\n');

  let base = content;
  if (!base.endsWith('\n')) base += '\n';
  const intro =
    missing.length === DIATAXIS_MODES.length
      ? '\nEvery document belongs in exactly one of these.\n\n'
      : '\n';
  return `${base}${intro}${entries}\n`;
}

/**
 * Scaffold the four mode directories and turn the gate on.
 *
 * Nothing at all happens when the gate cannot land in the root index. A tree
 * left with four new directories and the gate still off is worse than one left
 * alone: `checkMode` passes on it, so nothing ever says the adoption stopped
 * half way — and if the index was not rewritten to list them, `lat check index`
 * fails instead, on four directories the user never asked for.
 */
export function writeForkScaffold(latDir: string): void {
  const rootIndex = join(latDir, indexNameFor(basename(latDir)));
  const current = existsSync(rootIndex)
    ? readFileSync(rootIndex, 'utf-8')
    : null;
  const stamped = current === null ? null : stampRequireMode(current);
  if (stamped !== null && requireModeState(stamped) !== 'on') return;

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

  if (current !== null && stamped !== null) {
    const listed = listModeDirs(stamped);
    if (listed !== current) writeFileSync(rootIndex, listed);
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
 * it costs no edit to `src/init-version.ts`.
 */
function markerPath(latDir: string): string {
  return join(latDir, '.cache', 'lat_fork.json');
}

/** One recorded fact: this project was asked and said no. */
type ForkMeta = { require_mode_declined?: boolean };

function readForkMeta(latDir: string): ForkMeta {
  try {
    const raw: unknown = JSON.parse(readFileSync(markerPath(latDir), 'utf-8'));
    // An array is an object too, and spreading one produces `{"0": ...}` —
    // which then overwrites the file with something no reader understands.
    if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
      return raw as ForkMeta;
    }
  } catch {
    // Absent or unreadable — nothing has been settled yet.
  }
  return {};
}

function declined(latDir: string): boolean {
  return readForkMeta(latDir).require_mode_declined === true;
}

/**
 * Remember a no.
 *
 * The marker is a local answer, not a project fact: committed, it would tell
 * every other clone that this project had already declined. `lat.md/.gitignore`
 * covers `.cache/`, but that file is written only by the run that *creates*
 * `lat.md/` — and this path exists for trees `lat init` did not create — so the
 * cache is made to ignore itself rather than trusting a file that may not be
 * there.
 *
 * Failure to record is reported and survived. This runs after the tree has
 * already been restructured, and an unwritable cache directory is not a reason
 * to abort `lat init` with a stack trace at that point.
 */
function recordDeclined(latDir: string): void {
  try {
    const cacheDir = join(latDir, '.cache');
    mkdirSync(cacheDir, { recursive: true });
    const selfIgnore = join(cacheDir, '.gitignore');
    if (!existsSync(selfIgnore)) writeFileSync(selfIgnore, '*\n');
    writeFileSync(
      markerPath(latDir),
      JSON.stringify(
        { ...readForkMeta(latDir), require_mode_declined: true },
        null,
        2,
      ) + '\n',
    );
  } catch (err) {
    console.log(
      '  ' +
        styleText(
          'dim',
          `Could not record the answer (${(err as Error).message}) — the offer will repeat.`,
        ),
    );
  }
}

/**
 * What adopting the gate would newly cost, measured with the gate itself.
 *
 * Counted by running `checkMode` twice and taking the difference rather than
 * by re-implementing its classification here. The hand-written version drifted
 * immediately: it skipped every document inside a mode directory before
 * reading what that document declared, so two files with byte-identical
 * frontmatter were counted or not according to where they sat, and it reported
 * one offender against two errors. Advertising a document as settled and then
 * failing it is the failure worth avoiding, and only the checker knows.
 */
async function adoptionCost(latDir: string): Promise<string[]> {
  const projectRoot = dirname(latDir);
  const key = (error: CheckError): string =>
    `${error.file}:${error.line}:${error.message}`;
  const [gated, ungated] = await Promise.all([
    checkMode(latDir, projectRoot, { requireMode: true }),
    checkMode(latDir, projectRoot, { requireMode: false }),
  ]);
  const already = new Set(ungated.map(key));
  return [
    ...new Set(gated.filter((e) => !already.has(key(e))).map((e) => e.target)),
  ];
}

/** Say what is wrong with a root index the gate cannot be written into. */
function reportUnstampable(latDir: string, plan: StampPlan): void {
  const where = `${basename(latDir)}/${indexNameFor(basename(latDir))}`;
  console.log('');
  console.log(styleText('bold', 'Diátaxis modes'));
  console.log(
    '  ' +
      styleText('dim', `require-mode cannot be set in ${where}: `) +
      ('detail' in plan ? plan.detail : ''),
  );
  if (plan.kind === 'unparseable') {
    // Worth more than the offer that prompted it. Every `lat:` field on a
    // document whose frontmatter does not parse is silently ignored, so this
    // root index is already not being read.
    console.log(
      '  ' +
        styleText(
          'dim',
          'Until that parses, no `lat:` field on this document is read at all.',
        ),
    );
  }
}

/**
 * Offer the gate to a tree `lat init` did not create.
 *
 * `writeForkScaffold` runs only on the branch that creates `lat.md/`, which
 * left the flag unreachable for every project that already had one — that is,
 * for every project that needs it. Restructuring someone's tree without asking
 * is still wrong, so this asks.
 *
 * Whether the flag *can* be written is decided before anything is asked and
 * before anything is written. Asking first cost a tree four directories and a
 * rewritten index in exchange for a gate that never landed, and the user was
 * told in the same breath that nothing could be edited.
 *
 * Silent when the flag is already set either way, when a previous run was told
 * no, and when there is no TTY to ask — the non-interactive path prints the
 * count and the manual edit instead, and records nothing, so a later
 * interactive run still offers.
 */
export async function offerRequireMode(
  latDir: string,
  interactive: boolean,
  ask: (message: string) => Promise<boolean>,
): Promise<void> {
  const rootIndex = join(latDir, indexNameFor(basename(latDir)));
  if (!existsSync(rootIndex)) return;

  let current: string;
  try {
    current = readFileSync(rootIndex, 'utf-8');
  } catch {
    return;
  }

  const plan = planRequireMode(current);
  if (plan.kind === 'on' || plan.kind === 'off') return;
  if (plan.kind !== 'stamped') {
    // Not recorded and not silenced: this is a defect in the document with a
    // fix the user can apply, and it stops being printed the moment they do.
    reportUnstampable(latDir, plan);
    return;
  }
  if (declined(latDir)) return;

  const offenders = await adoptionCost(latDir);

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
    recordDeclined(latDir);
    console.log(
      '  ' +
        styleText('dim', 'Skipped. Add') +
        ' require-mode: true ' +
        styleText('dim', 'to the root index whenever you want it.'),
    );
    return;
  }

  writeFileSync(rootIndex, plan.content);
  if (plan.movedRootKey) {
    console.log(
      '  ' +
        styleText(
          'dim',
          'Moved the stray root-level require-mode under `lat:`, where it is read.',
        ),
    );
  }
  writeForkScaffold(latDir);

  if (offenders.length > 0) {
    console.log(
      '  ' +
        styleText('dim', 'Run') +
        ' lat check ' +
        styleText('dim', 'to see which documents need placing.'),
    );
  }
}
