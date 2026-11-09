import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..');
const VIEW_SRC = join(ROOT, 'view/src');
const FORK_USAGE = join(ROOT, 'src/fork/usage');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

/** Specifiers of the imports and re-exports that survive compilation. */
function runtimeImports(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const found: string[] = [];
  const statement =
    /(?:^|\n)\s*(?:import|export)\s+(type\s+)?([^;'"]*?)\s*from\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;
  for (const match of text.matchAll(statement)) {
    const [, typeOnly, clause, specifier, bare] = match;
    if (bare) {
      found.push(bare);
      continue;
    }
    if (typeOnly) continue;
    const names = clause
      .replace(/^[^{]*\{|\}[^}]*$/g, '')
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean);
    const braced = clause.includes('{') && !/^[\w$*]/.test(clause.trim());
    if (braced && names.every((name) => name.startsWith('type '))) continue;
    found.push(specifier);
  }
  return found;
}

function resolveRelative(from: string, specifier: string): string | null {
  const base = resolve(dirname(from), specifier.replace(/\.js$/, ''));
  for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts')])
    if (existsSync(candidate)) return candidate;
  return null;
}

/** The first runtime import chain from a file that leaves pure code, or null. */
function impureChain(file: string, seen = new Set<string>()): string[] | null {
  if (seen.has(file)) return null;
  seen.add(file);
  for (const specifier of runtimeImports(file)) {
    if (!specifier.startsWith('.')) return [file, specifier];
    const target = resolveRelative(file, specifier);
    if (!target) throw new Error(`${specifier} in ${file} does not resolve`);
    const chain = impureChain(target, seen);
    if (chain) return [file, ...chain];
  }
  return null;
}

describe('usage view imports', () => {
  // @lat: [[usage-dashboard-shell#Usage Dashboard Shell#The view bundle imports no server modules]]
  it('reaches no node builtin or package through src/fork/usage at runtime', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(VIEW_SRC))
      for (const specifier of runtimeImports(file)) {
        if (!specifier.startsWith('.')) continue;
        const target = resolveRelative(file, specifier);
        if (!target?.startsWith(FORK_USAGE)) continue;
        const chain = impureChain(target);
        if (chain)
          offenders.push(
            [file, ...chain].map((p) => p.replace(`${ROOT}/`, '')).join(' -> '),
          );
      }
    expect(offenders).toEqual([]);
  });

  it('detects a server module in a runtime import chain', () => {
    expect(
      impureChain(join(FORK_USAGE, 'event-index.ts'))?.at(-1),
    ).toBeTruthy();
  });
});
