// Caller lookup through an external knowledge store that supports the
// 'callers' operation. Fails open: any problem gives no callers.
import { isAbsolute, win32 } from 'node:path';
import { readExternalStoreConfigs, runStoreCommand } from './external.js';

export type CodeSymbol = { file: string; name: string };
export type Caller = { file: string; name: string; line: number };

export type FindCallersOptions = {
  /** How many call levels to follow. Default 1. */
  depth?: number;
  /** Federation time left, in milliseconds. */
  remainingMs?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

function isCodeSymbol(value: unknown): value is CodeSymbol {
  return (
    isRecord(value) &&
    typeof value.file === 'string' &&
    typeof value.name === 'string'
  );
}

function isInsideProject(file: string): boolean {
  return (
    !isAbsolute(file) &&
    !win32.isAbsolute(file) &&
    !file.split(/[\\/]/).includes('..')
  );
}

function isCaller(value: unknown): value is Caller {
  return (
    isCodeSymbol(value) &&
    typeof (value as Record<string, unknown>).line === 'number' &&
    isInsideProject(value.file)
  );
}

/**
 * The callers of each symbol, keyed by `file#name`, from the first
 * configured store whose operations include 'callers'. Returns an empty Map
 * when there is no such store or on any error, and skips wrongly shaped
 * entries and callers whose file leaves the project.
 */
export async function findCallers(
  projectRoot: string,
  symbols: CodeSymbol[],
  options: FindCallersOptions = {},
): Promise<Map<string, Caller[]>> {
  const callersByKey = new Map<string, Caller[]>();
  const store = readExternalStoreConfigs().find((config) =>
    config.operations.includes('callers'),
  );
  if (!store) return callersByKey;
  const stdout = await runStoreCommand(
    store,
    { operation: 'callers', projectRoot, symbols, depth: options.depth ?? 1 },
    options.remainingMs,
  );
  if (stdout === null) return callersByKey;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return callersByKey;
  }
  if (!Array.isArray(parsed)) return callersByKey;
  for (const entry of parsed) {
    if (!isRecord(entry) || !isCodeSymbol(entry.symbol)) continue;
    if (!Array.isArray(entry.callers)) continue;
    const { file, name } = entry.symbol;
    callersByKey.set(`${file}#${name}`, entry.callers.filter(isCaller));
  }
  return callersByKey;
}
