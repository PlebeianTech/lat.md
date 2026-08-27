import { readFile } from 'node:fs/promises';
import { relative } from 'node:path';
import { scanCodeRefs } from '../code-refs.js';
import { listLatticeFiles } from '../lattice.js';
import { indexNameFor } from './check-mode.js';
import { toPosix } from '../walk.js';
import { basename, dirname } from 'node:path';
import type { CheckError } from './check.js';

/**
 * Fail a `lat.md/` tree that has documents and no `@lat:` ref pointing into it
 * from anywhere in the codebase.
 *
 * `require-code-mention` was the only thing asking for refs, and it is opt-in
 * frontmatter: an agent setting up a tree can simply not write it, and every
 * check still passes. One did. Its reasons were both ordinary — it read a list
 * of example comment markers as an exclusive language list and concluded its
 * language was unsupported, and it was optimising for a green check rather
 * than a correct one, so the option that could not fail was the one it took.
 *
 * A graph nothing points at cannot be reached from the code, which is the only
 * reason it exists. So the floor is one ref, and the message says where to put
 * the first one.
 *
 * Deliberately a floor and not a coverage ratio. Half this repository's own
 * documents have no incoming ref and should not have one — a per-document rule
 * would have to be either wrong here or watered down everywhere.
 */

/** Nothing to anchor: a tree of pure navigation, or a project with no code. */
function isIndex(latticeDir: string, file: string): boolean {
  const holder = basename(dirname(file));
  return (
    basename(file) ===
    indexNameFor(holder === '' ? basename(latticeDir) : holder)
  );
}

export async function checkCoverage(
  latticeDir: string,
  projectRoot = dirname(latticeDir),
): Promise<CheckError[]> {
  const files = await listLatticeFiles(latticeDir);
  const documents = files.filter((f) => !isIndex(latticeDir, f));
  if (documents.length === 0) return [];

  const scan = await scanCodeRefs(projectRoot);
  if (scan.files.length === 0) return [];
  if (scan.refs.length > 0) return [];

  const rootIndexPath = `${latticeDir}/${indexNameFor(basename(latticeDir))}`;
  const rootIndexRel = toPosix(relative(process.cwd(), rootIndexPath));

  // Quote the ref the reader should actually paste. A generic placeholder gets
  // pasted verbatim and then fails `lat check code-refs`, which turns one
  // error into two.
  const stem = basename(latticeDir).replace(/\.md$/, '');
  let anchor = `${stem}#Your Project`;
  try {
    const heading = (await readFile(rootIndexPath, 'utf-8')).match(
      /^#\s+(.+)$/m,
    );
    if (heading) anchor = `${stem}#${heading[1].trim()}`;
  } catch {
    // No root index, or unreadable — the placeholder still names the shape.
  }

  return [
    {
      file: rootIndexRel,
      line: 1,
      target: toPosix(relative(projectRoot, latticeDir)),
      message:
        `${documents.length} document(s) here and no \`@lat:\` code ref anywhere in the project — nothing in the codebase can reach this graph.\n` +
        '    Start at the application entrypoint (config/application.rb, src/index.ts, main.go, manage.py) and point it at the root index:\n' +
        `        # @lat: [[${anchor}]]\n` +
        '    Then add one ref per section that source code implements, at that code.\n' +
        '    The marker is a comment syntax, not a language allowlist: `//` for C-family, `#` for Ruby, Python, shell, Elixir and the rest. The scan is textual and reads every non-markdown file.\n' +
        '    An `@lat:` line is a machine directive, like a magic comment or a linter pragma. A project convention that minimises comments does not reach it.',
    },
  ];
}
