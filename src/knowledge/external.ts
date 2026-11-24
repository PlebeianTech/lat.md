// External knowledge stores: commands the user registers under
// `knowledge_stores` in their own lat config.json. A store is read ONLY from
// the user-level config, never from a file in the repository: repository
// content is attacker-controlled, and a command declared there would run
// arbitrary code on the prompt path.
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { getConfigPath } from '@plebeiantech/lat.md-core/config';
import type { KnowledgeHit, Store, StoreQuery } from './types.js';

const BUILT_IN_NAMES = new Set(['cq', 'bd', 'claude-memory']);
const STORE_NAME = /^[A-Za-z0-9-]+$/;
const DEFAULT_TIMEOUT_MS = 2000;

export type ExternalStoreConfig = {
  name: string;
  label: string;
  /** Executable, then its arguments. Run with no shell. */
  command: string[];
  operations: string[];
  timeoutMs: number;
};

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === 'string')
  );
}

function parseEntry(entry: unknown): ExternalStoreConfig | null {
  if (!entry || typeof entry !== 'object') return null;
  const { name, label, command, operations, timeout_ms } = entry as Record<
    string,
    unknown
  >;
  if (typeof name !== 'string' || !STORE_NAME.test(name)) return null;
  if (typeof label !== 'string' || label === '') return null;
  if (!isStringArray(command) || command.length === 0) return null;
  if (operations !== undefined && !isStringArray(operations)) return null;
  if (
    timeout_ms !== undefined &&
    (typeof timeout_ms !== 'number' || timeout_ms <= 0)
  ) {
    return null;
  }
  return {
    name,
    label,
    command,
    operations: operations ?? ['query'],
    timeoutMs: timeout_ms ?? DEFAULT_TIMEOUT_MS,
  };
}

/**
 * The stores registered in the user's config, in config order. Returns []
 * on any problem and never exits: this runs inside a prompt hook, which is
 * why it does not call readConfig. Skips malformed entries and any entry
 * whose name a built-in or an earlier entry already uses.
 */
export function readExternalStoreConfigs(): ExternalStoreConfig[] {
  let entries: unknown;
  try {
    const config: unknown = JSON.parse(readFileSync(getConfigPath(), 'utf-8'));
    entries = (config as Record<string, unknown> | null)?.knowledge_stores;
  } catch {
    return [];
  }
  if (!Array.isArray(entries)) return [];
  const usedNames = new Set(BUILT_IN_NAMES);
  const stores: ExternalStoreConfig[] = [];
  for (const entry of entries) {
    const store = parseEntry(entry);
    if (store === null || usedNames.has(store.name)) continue;
    usedNames.add(store.name);
    stores.push(store);
  }
  return stores;
}

function isHit(value: unknown): value is Omit<KnowledgeHit, 'store'> {
  if (!value || typeof value !== 'object') return false;
  const { key, title, detail, score } = value as Record<string, unknown>;
  return (
    typeof key === 'string' &&
    typeof title === 'string' &&
    typeof detail === 'string' &&
    typeof score === 'number'
  );
}

function parseHits(
  storeName: string,
  stdout: string,
  limit: number,
): KnowledgeHit[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter(isHit)
    .slice(0, limit)
    .map(({ key, title, detail, score }) => ({
      store: storeName,
      key,
      title,
      detail,
      score,
    }));
}

/**
 * Runs one store command with `request` as JSON on stdin and resolves to its
 * stdout, or null on a non-zero exit, a timeout or any other error. The
 * child is killed at the smaller of the store's own timeout and `remainingMs`
 * (the federation time left), so an abandoned request cannot keep Node alive.
 */
export function runStoreCommand(
  store: ExternalStoreConfig,
  request: object,
  remainingMs: number = Infinity,
): Promise<string | null> {
  const timeout = Math.min(store.timeoutMs, remainingMs);
  if (timeout <= 0) return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const child = execFile(
        store.command[0],
        store.command.slice(1),
        { encoding: 'utf-8', timeout, killSignal: 'SIGKILL' },
        (error, stdout) => resolve(error ? null : stdout),
      );
      // A store that exits without reading stdin makes this write fail.
      child.stdin?.on('error', () => {});
      child.stdin?.end(JSON.stringify(request));
    } catch {
      resolve(null);
    }
  });
}

/** Resolves to [] on any failure of the store command or its output. */
async function runQuery(
  store: ExternalStoreConfig,
  q: StoreQuery,
): Promise<KnowledgeHit[]> {
  const stdout = await runStoreCommand(
    store,
    {
      operation: 'query',
      terms: q.terms,
      projectRoot: q.projectRoot,
      limit: q.limit,
    },
    q.remainingMs,
  );
  return stdout === null ? [] : parseHits(store.name, stdout, q.limit);
}

export function externalStore(config: ExternalStoreConfig): Store {
  return {
    name: config.name,
    label: config.label,
    query: (q) => runQuery(config, q),
  };
}

/** One Store per configured entry that supports the 'query' operation. */
export function externalStores(): Store[] {
  return readExternalStoreConfigs()
    .filter((config) => config.operations.includes('query'))
    .map(externalStore);
}
