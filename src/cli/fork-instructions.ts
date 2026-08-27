import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { styleText } from 'node:util';
import { contentHash, readFileHash } from '../init-version.js';
import { findTemplatesDir } from './templates.js';

/**
 * The fork's own instruction channel into a consumer project.
 *
 * Upstream teaches a consumer's agent through `templates/AGENTS.md` and
 * `templates/skill/SKILL.md`. Both are upstream files, and both are the ones
 * upstream is most likely to rewrite, so every sentence this fork adds to them
 * is a merge conflict bought on credit. The fork's Diátaxis block cost 13
 * lines in one and 14 in the other before this module existed.
 *
 * Everything here writes into fork-owned paths instead. The entire upstream
 * footprint is one import and one call in `initCmd`.
 *
 * Two shapes, because the destinations behave differently:
 *
 * - Always-loaded instruction files (`CLAUDE.md`, `AGENTS.md`,
 *   `.github/copilot-instructions.md`) already carry upstream's
 *   `%% lat:begin %%` block, so this appends a *second* block under its own
 *   `%% lat-fork:begin %%` markers. Upstream's `appendTemplateSection` slices
 *   between its own markers and leaves anything after them intact, so the two
 *   blocks do not fight on re-run.
 * - Skill directories get a separate `lat-md-conventions/SKILL.md`. Upstream
 *   writes its `lat-md` skill with a whole-file hash comparison, so appending
 *   to that file would make every later `lat init` report it as
 *   user-modified and prompt.
 */

const FORK_BEGIN = '%% lat-fork:begin %%';
const FORK_END = '%% lat-fork:end %%';

/**
 * Hash-map key for a fork block inside a file upstream also owns. Suffixed so
 * it can never collide with upstream's entry for the same path — both live in
 * one flat `file_hashes` record.
 */
function forkHashKey(relPath: string): string {
  return `${relPath}#lat-fork`;
}

/** Instruction files that use upstream's marker-append shape. */
const BLOCK_TARGETS = [
  'CLAUDE.md',
  'AGENTS.md',
  '.github/copilot-instructions.md',
];

/**
 * Skill roots every agent integration installs into. Written to only when the
 * directory already exists, which is what keeps this list from creating skill
 * directories for agents the user did not select.
 */
const SKILL_ROOTS = [
  '.claude/skills',
  '.pi/skills',
  '.agents/skills',
  '.codex/skills',
];

const SKILL_NAME = 'lat-md-conventions';

const SKILL_FRONTMATTER = `---
name: ${SKILL_NAME}
description: >-
  Rules lat check enforces in this project: Diátaxis mode placement for every
  lat.md/ document, mandatory @lat: code refs starting at the application
  entrypoint, and test specs wired to their tests. Load alongside lat-md
  whenever creating or editing files under lat.md/.
---

`;

export function readForkConventions(): string {
  return readFileSync(
    join(findTemplatesDir(), 'fork', 'conventions.md'),
    'utf-8',
  );
}

function wrapBlock(body: string): string {
  return `${FORK_BEGIN}\n${body}${body.endsWith('\n') ? '' : '\n'}${FORK_END}\n`;
}

/**
 * Replace the fork block in `content`, or append one when absent.
 *
 * Returns null when the block is already byte-identical, so the caller can
 * stay quiet rather than announce a write that did not happen.
 */
export function spliceForkBlock(content: string, body: string): string | null {
  const wrapped = wrapBlock(body);
  const begin = content.indexOf(FORK_BEGIN);
  const end = content.indexOf(FORK_END);

  if (begin === -1 || end === -1 || end <= begin) {
    let base = content;
    if (base.length > 0 && !base.endsWith('\n')) base += '\n';
    return base + (base.length > 0 ? '\n' : '') + wrapped;
  }

  const endWithMarker = end + FORK_END.length;
  const endWithNl =
    content[endWithMarker] === '\n' ? endWithMarker + 1 : endWithMarker;
  const existing = content.slice(begin, endWithNl);
  if (existing === wrapped) return null;

  return content.slice(0, begin) + wrapped + content.slice(endWithNl);
}

/** Read the body currently fenced by the fork markers, or null if absent. */
export function extractForkBlock(content: string): string | null {
  const begin = content.indexOf(FORK_BEGIN);
  const end = content.indexOf(FORK_END);
  if (begin === -1 || end === -1 || end <= begin) return null;
  return content.slice(begin + FORK_BEGIN.length + 1, end);
}

/**
 * Write the fork's conventions into every instruction file and skill directory
 * the selected agents produced.
 *
 * `fileHashes` is upstream's record, threaded through so `writeInitMeta`
 * persists these entries alongside its own; a stored hash is what lets a later
 * run tell "the user edited our block" from "the template moved on".
 */
export async function writeForkInstructions(
  root: string,
  latDir: string,
  fileHashes: Record<string, string>,
  ask: (message: string) => Promise<boolean>,
): Promise<void> {
  const body = readForkConventions();
  const bodyHash = contentHash(body);
  const written: string[] = [];

  for (const relPath of BLOCK_TARGETS) {
    const absPath = join(root, relPath);
    if (!existsSync(absPath)) continue;

    const current = readFileSync(absPath, 'utf-8');
    const existingBlock = extractForkBlock(current);

    if (existingBlock !== null) {
      const existingHash = contentHash(existingBlock);
      if (existingHash === bodyHash) {
        fileHashes[forkHashKey(relPath)] = bodyHash;
        continue;
      }
      const storedHash = readFileHash(latDir, forkHashKey(relPath));
      if (storedHash && existingHash !== storedHash) {
        console.log(
          styleText('yellow', `  ${relPath}`) +
            ' lat-fork section has been modified.',
        );
        if (!(await ask('  Replace lat-fork section with latest template?'))) {
          console.log(styleText('dim', '  Kept existing section.'));
          continue;
        }
      }
    }

    const updated = spliceForkBlock(current, body);
    if (updated === null) {
      fileHashes[forkHashKey(relPath)] = bodyHash;
      continue;
    }
    writeFileSync(absPath, updated);
    fileHashes[forkHashKey(relPath)] = bodyHash;
    written.push(relPath);
  }

  const skillBody = SKILL_FRONTMATTER + body;
  const skillHash = contentHash(skillBody);

  for (const skillRoot of SKILL_ROOTS) {
    const rootAbs = join(root, skillRoot);
    if (!existsSync(rootAbs)) continue;

    const relPath = `${skillRoot}/${SKILL_NAME}/SKILL.md`;
    const absPath = join(root, relPath);

    if (existsSync(absPath)) {
      const current = readFileSync(absPath, 'utf-8');
      if (contentHash(current) === skillHash) {
        fileHashes[relPath] = skillHash;
        continue;
      }
      const storedHash = readFileHash(latDir, relPath);
      if (storedHash && contentHash(current) !== storedHash) {
        console.log(
          styleText('yellow', `  ${relPath}`) + ' has been modified.',
        );
        if (!(await ask('  Overwrite with latest lat template?'))) {
          console.log(styleText('dim', '  Kept existing file.'));
          continue;
        }
      }
    }

    mkdirSync(join(absPath, '..'), { recursive: true });
    writeFileSync(absPath, skillBody);
    fileHashes[relPath] = skillHash;
    written.push(relPath);
  }

  if (written.length > 0) {
    console.log('');
    console.log(
      styleText('green', '  lat.md conventions') +
        ' written to ' +
        written.join(', '),
    );
  }
}
