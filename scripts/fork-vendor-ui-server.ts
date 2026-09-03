// Vendors the @lat.md/server build into the published tarball.
//
// Upstream split the UI's Express runtime into a workspace package and made it
// a plain `dependencies` entry, but has not published it to npm — their own
// latest release predates the split, so nothing of theirs installs it either.
// pnpm rewrites `workspace:*` to `0.1.0` at pack time, and every consumer of
// the fork then fails to install with a 404 on @lat.md/server.
//
// The fix keeps the fork's dependency graph made only of plain registry
// packages, because that is the one shape every installer agrees on: mise's
// resolver rejected the 404 outright, and bundledDependencies is refused by
// pnpm under the isolated node linker. So the compiled server is copied into
// dist/vendor and the bare specifier in the emitted output is rewritten to a
// relative path. `express`, its only external import, moves up into the
// fork's own dependencies.
//
// Delete this script, and its call in `build`, once upstream publishes
// @lat.md/server — the workspace dependency alone works again at that point.

import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPECIFIER = '@lat.md/server';
const source = join(root, 'packages/server/dist');
const vendor = join(root, 'dist/vendor/lat.md-server');
const entry = join(vendor, 'index.js');

if (!existsSync(join(source, 'index.js'))) {
  console.error(
    `${SPECIFIER} is not built: ${relative(root, source)}/index.js is missing.\n` +
      'Run `pnpm build:packages` (or `pnpm buildall`) before `pnpm build`.',
  );
  process.exit(1);
}

await mkdir(dirname(vendor), { recursive: true });
await cp(source, vendor, { recursive: true });

// Walking the whole emitted tree rather than naming src/view/server.ts keeps
// this correct if upstream adds a second importer, and makes it idempotent:
// a second run finds nothing left to rewrite.
async function* emitted(dir: string): AsyncGenerator<string> {
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, item.name);
    if (item.isDirectory()) yield* emitted(path);
    else if (item.name.endsWith('.js') || item.name.endsWith('.d.ts')) yield path;
  }
}

const rewritten = [];
for await (const file of emitted(join(root, 'dist/src'))) {
  const before = await readFile(file, 'utf-8');
  if (!before.includes(SPECIFIER)) continue;
  // A POSIX separator regardless of platform, and always explicitly relative:
  // Node reads a bare specifier as a package name, not a sibling file.
  let target = relative(dirname(file), entry).split('\\').join('/');
  if (!target.startsWith('.')) target = `./${target}`;
  await writeFile(file, before.split(`'${SPECIFIER}'`).join(`'${target}'`));
  rewritten.push(relative(root, file));
}

const missed = [];
for await (const file of emitted(join(root, 'dist/src'))) {
  if ((await readFile(file, 'utf-8')).includes(SPECIFIER)) missed.push(relative(root, file));
}
if (missed.length > 0) {
  console.error(
    `${SPECIFIER} still appears in emitted output after rewriting:\n  ${missed.join('\n  ')}\n` +
      'Those imports would 404 for anyone installing the published package.',
  );
  process.exit(1);
}

console.log(
  `Vendored ${SPECIFIER} into ${relative(root, vendor)}` +
    (rewritten.length > 0 ? `; rewrote ${rewritten.join(', ')}` : '; nothing left to rewrite'),
);
