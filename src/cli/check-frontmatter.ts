import { readFile } from 'node:fs/promises';
import { dirname, relative } from 'node:path';
import { listLatticeFiles, parseFrontmatter } from '../lattice.js';
import { toPosix } from '../walk.js';
import type { CheckError } from './check.js';

/**
 * Report frontmatter that parses to nothing useful, or that puts a lat field
 * somewhere the parser will not look.
 *
 * Both failures are quiet by nature, and both fail OPEN. A misplaced or
 * unparseable `require-code-mention` turns a validation off, and `lat check`
 * then reports success on a file whose leaf sections are no longer required to
 * carry `@lat:` coverage. Nothing else in the output says the rule stopped
 * applying, which is precisely why it has to be said here.
 */
export async function checkFrontmatter(
  latticeDir: string,
  projectRoot = dirname(latticeDir),
): Promise<CheckError[]> {
  const files = await listLatticeFiles(latticeDir);
  const errors: CheckError[] = [];

  for (const file of files) {
    const content = await readFile(file, 'utf-8');
    const problems = parseFrontmatter(content).problems;
    if (!problems) continue;

    const relPath = relative(process.cwd(), file);
    const target = toPosix(relative(projectRoot, file)).replace(/\.md$/, '');

    for (const problem of problems) {
      if (problem.kind === 'root-level-field') {
        errors.push({
          file: relPath,
          line: 1,
          target,
          message: `frontmatter sets "${problem.field}" at the document root, where it is ignored — nest it under "lat:" instead:\n    ---\n    lat:\n      ${problem.field}: ...\n    ---`,
        });
        continue;
      }
      errors.push({
        file: relPath,
        line: 1,
        target,
        message: `frontmatter is not valid YAML (${problem.message}) — every lat field in this document is being ignored, including any that turn a check on`,
      });
    }
  }

  return errors;
}
