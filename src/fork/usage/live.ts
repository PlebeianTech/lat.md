/**
 * Live usage endpoints of the `lat ui` server: the aggregate as JSON, a
 * server-sent event stream that announces new data, and the dashboard page.
 *
 * REGISTRATION POINT. A later issue adds a JSON route by appending ONE line to
 * the ROUTES block at the bottom of this file:
 *
 *   registerUsageRoute('/api/usage/example', exampleHandler);
 *
 * Nothing else in this file changes for a route; the handler lives in its
 * owner's file.
 *
 * Lifecycle. `src/view/server.ts` has one dispatch line and cannot hook the
 * server's close(), so the watchers belong to this module: they start on the
 * first request under /api/usage and stop when the last event-stream client
 * disconnects. A client that only ever sends plain GETs leaves them running
 * until the process ends; they are unref'd and never keep it alive.
 *
 * One bd watcher serves a root: the aggregator and the raw event index share
 * the one made when the root starts, so a change runs the bd commands once.
 *
 * Change detection watches three things: the event logs under
 * <root>/.lat/usage/, the transcript directories of every session reader
 * (only while usage is enabled),
 * and the bd database (its fingerprint, polled). A change is a different
 * signature of sizes, modification times and fingerprints; state.json is
 * ignored so the aggregator's own saves never announce themselves. On a
 * change the aggregator reads only the new data (checkpointed in state.json)
 * and one `usage-change` event is pushed.
 *
 * Graph snapshots remember failed, dirty and not-captured heads for the life
 * of the process. When the git head moves, forgetSnapshots() runs so the next
 * refresh evaluates them again. The head is detected by the modification of
 * `<git dir>/logs/HEAD`, where the git dir is the nearest `.git` at or above
 * the project root; a repository without a reflog never heals.
 *
 * A refresh that throws still advances the signature and head, so later polls
 * do not retry it or forget snapshots again, and pushes `usage-error` with
 * `{ instanceId, message }`. The next successful change pushes `usage-change`,
 * which clears it.
 */
import { randomUUID } from 'node:crypto';
import {
  readdirSync,
  readFileSync,
  statSync,
  watch,
  type FSWatcher,
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { rewriteClientAssetUrls } from '../../view/client-shell.js';
import {
  createAggregator,
  type Aggregator,
  type AggregatorOptions,
} from './aggregate.js';
import { createBdWatcher, type BdWatcher } from './bd-attribution.js';
import { beadsDirFingerprint, resolveBeadsDir } from './bd-client.js';
import { findGitEntry } from './cli-tap.js';
import { usageEnabled } from './enabled.js';
import { parseUsageFilters, type UsageFilters } from './filters.js';
import { findingsRoute } from './findings.js';
import { forgetSnapshots } from './graph-snapshot.js';
import { rawEventsRoute } from './live-raw-events.js';
import { USAGE_SCHEMA_VERSION } from './schema.js';
import { sessionSources } from './sources/index.js';
import type { SessionSource } from './sources/types.js';
import { warnOnceIfUsageTracked } from './tracked-usage.js';

// @lat: [[usage-live#Usage Live#Routes register through registerUsageRoute]]
export interface UsageRouteContext {
  root: string;
  url: URL;
  filters: UsageFilters;
  aggregator: Aggregator;
  /** The root's bd watcher, shared with the aggregator. Unset for MCP. */
  bd?: Pick<BdWatcher, 'refresh'>;
  // @lat: [[usage-live-raw-events#Usage Live Raw Events#Raw and findings requests share the discovery of a change]]
  /** The live server's sources, which share one discovery. Unset for MCP. */
  sources?: SessionSource[];
}

export type UsageRouteHandler = (
  context: UsageRouteContext,
) => unknown | Promise<unknown>;

export interface UsageLiveOptions extends Partial<AggregatorOptions> {
  /** How often the signature is checked without a file event. */
  pollMs?: number;
  heartbeatMs?: number;
  /** How long a file event waits for more events before one check runs. */
  debounceMs?: number;
}

const EVENTS_PATH = '/api/usage/events';
const LOG_FILE = /^events-\d{4}-\d{2}\.jsonl$/;
const instanceId = randomUUID();
const routes = new Map<string, UsageRouteHandler>();
let options: UsageLiveOptions = {};

export function registerUsageRoute(
  path: string,
  handler: UsageRouteHandler,
): void {
  if (routes.has(path) || path === EVENTS_PATH)
    throw new Error(`Usage route already registered: ${path}`);
  routes.set(path, handler);
}

/** Replaces the aggregator options and timings of live servers; for tests. */
export function configureUsageLive(next: UsageLiveOptions): void {
  options = next;
}

interface Live {
  root: string;
  bd: Pick<BdWatcher, 'refresh'>;
  aggregator: Promise<Aggregator>;
  ready: Promise<void>;
  streams: Set<ServerResponse>;
  watchers: Map<string, FSWatcher>;
  timers: NodeJS.Timeout[];
  signature: string;
  head: string;
  queue: Promise<unknown>;
  scheduled: boolean;
  /** The pending debounced check, cleared when the live stops. */
  debounce: NodeJS.Timeout | null;
  /** Session transcripts found by the last discovery; null before the first. */
  discovered: Set<string> | null;
  changeFiles: Set<string>;
  rechecked: Set<string>;
  // @lat: [[usage-live#Usage Live#Requests after a change share one discovery]]
  walks: Map<SessionSource, Promise<string[]>>;
  sources: SessionSource[];
  stopped: boolean;
}

const lives = new Map<string, Live>();
/** The queue of the last stopped live by root: its refresh must end first. */
const retired = new Map<string, Promise<unknown>>();

/** Runs jobs one at a time so refreshes never overlap. */
function exclusive<T>(live: Live, job: () => Promise<T>): Promise<T> {
  const run = live.queue.then(job);
  live.queue = run.catch(() => undefined);
  return run;
}

/** `sources` discovering through `walks`; clearing `walks` forces a new walk. */
// @lat: [[usage-live#Usage Live#A walk in flight is shared and an invalidation is kept]]
export function shareDiscovery(
  sources: SessionSource[],
  walks: Map<SessionSource, Promise<string[]>>,
): SessionSource[] {
  return sources.map((source) => ({
    ...source,
    discover: (repoRoot: string) => {
      let walk = walks.get(source);
      if (!walk) {
        walk = source.discover(repoRoot);
        walks.set(source, walk);
      }
      return walk;
    },
  }));
}

function stat(path: string): string {
  try {
    const { size, mtimeMs } = statSync(path);
    return `${path}:${size}:${mtimeMs}`;
  } catch {
    return `${path}:missing`;
  }
}

function headFingerprint(root: string): string {
  try {
    // The project may sit below the repository root, so look upward.
    const worktree = findGitEntry(root);
    if (worktree === null) return '';
    let gitDir = join(worktree, '.git');
    if (statSync(gitDir).isFile())
      gitDir = resolve(
        worktree,
        readFileSync(gitDir, 'utf-8')
          .replace(/^gitdir:\s*/, '')
          .trim(),
      );
    return stat(join(gitDir, 'logs', 'HEAD'));
  } catch {
    return '';
  }
}

// @lat: [[usage-live#Usage Live#Source discovery is reused between checks]]
function needsDiscovery(live: Live, path: string | null): boolean {
  if (path === null) return true;
  if (live.discovered?.has(path)) return false;
  if (live.changeFiles.has(path)) return true;
  if (live.rechecked.has(path)) return false;
  live.rechecked.add(path);
  return true;
}

function watchDirectories(live: Live, wanted: Map<string, RegExp | null>) {
  for (const [dir, watcher] of live.watchers)
    if (!wanted.has(dir)) {
      watcher.close();
      live.watchers.delete(dir);
    }
  for (const [dir, only] of wanted) {
    if (live.watchers.has(dir)) continue;
    try {
      const watcher = watch(dir, { persistent: false }, (_event, name) => {
        // @lat: [[usage-live#Usage Live#Reading a WAL database starts no new discovery]]
        if (name?.toString().endsWith('-shm')) return;
        if (only === null || !name || only.test(name.toString())) {
          if (
            only === null &&
            needsDiscovery(live, name ? join(dir, name.toString()) : null)
          )
            live.walks.clear();
          trigger(live);
        }
      });
      watcher.on('error', () => undefined);
      live.watchers.set(dir, watcher);
    } catch {
      // The directory does not exist yet; the next check tries again.
    }
  }
}

/** Reads sizes and times only, and keeps the directory watchers current. */
async function observe(live: Live) {
  const { root } = live;
  const usageDir = join(root, '.lat', 'usage');
  const wanted = new Map<string, RegExp | null>([[usageDir, LOG_FILE]]);
  const parts: string[] = [];
  try {
    for (const name of readdirSync(usageDir).sort())
      if (LOG_FILE.test(name)) parts.push(stat(join(usageDir, name)));
  } catch {
    parts.push('no-logs');
  }
  // Usage off: read no session store, as aggregate.refresh and the event index.
  // Discovery walks the agents' stores, so every caller shares one walk of each.
  const changeFiles = new Set<string>();
  if (!usageEnabled(root)) {
    live.walks.clear();
    live.discovered = null;
  } else {
    const found: string[] = [];
    for (const source of live.sources) {
      const paths = await source.discover(root);
      found.push(...paths);
      // @lat: [[usage-live#Usage Live#A session path with no file follows its change files]]
      for (const path of paths)
        for (const file of source.changeFiles?.(path) ?? [path])
          changeFiles.add(file);
    }
    live.discovered = new Set(found);
    parts.push(beadsDirFingerprint(resolveBeadsDir(root)));
  }
  live.changeFiles = changeFiles;
  for (const file of changeFiles) {
    parts.push(stat(file));
    wanted.set(dirname(file), null);
  }
  const head = headFingerprint(root);
  parts.push(head);
  watchDirectories(live, wanted);
  return { signature: parts.join('\n'), head };
}

function broadcast(live: Live, message: string): void {
  for (const stream of live.streams) stream.write(message);
}

async function check(live: Live): Promise<void> {
  if (live.stopped) return;
  const next = await observe(live);
  if (next.signature === live.signature) return;
  if (next.head !== live.head) {
    forgetSnapshots();
    (await live.aggregator).invalidate();
  }
  // Advance first: a failing refresh must not look like a new change on every poll.
  live.signature = next.signature;
  live.head = next.head;
  let event = `event: usage-change\ndata: ${JSON.stringify({ instanceId })}\n\n`;
  try {
    await (await live.aggregator).refresh();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    event = `event: usage-error\ndata: ${JSON.stringify({ instanceId, message })}\n\n`;
  }
  broadcast(live, event);
}

function trigger(live: Live): void {
  if (live.scheduled || live.stopped) return;
  live.scheduled = true;
  // Events that arrive while the timer waits join this one check.
  live.debounce = setTimeout(() => {
    live.debounce = null;
    exclusive(live, async () => {
      live.scheduled = false;
      await check(live);
    }).catch(() => undefined);
  }, options.debounceMs ?? 50);
  live.debounce.unref();
}

/** Runs one change check now; resolves when it and its push are done. */
export async function checkUsageLive(root: string): Promise<void> {
  const live = lives.get(root);
  if (!live) return;
  await live.ready;
  live.walks.clear();
  await exclusive(live, () => check(live));
}

export function usageLiveStatus(root: string) {
  const live = lives.get(root);
  return { watching: live !== undefined, streams: live?.streams.size ?? 0 };
}

function stopLive(live: Live): void {
  live.stopped = true;
  if (live.debounce) clearTimeout(live.debounce);
  for (const timer of live.timers) clearInterval(timer);
  for (const watcher of live.watchers.values()) watcher.close();
  live.watchers.clear();
  for (const stream of live.streams) stream.end();
  live.streams.clear();
  if (lives.get(live.root) === live) lives.delete(live.root);
  retired.set(live.root, live.queue);
}

/** Stops the watchers of one project root, or of all of them. */
export function stopUsageLive(root?: string): void {
  for (const live of [...lives.values()])
    if (root === undefined || live.root === root) stopLive(live);
}

function startLive(root: string): Live {
  warnOnceIfUsageTracked(root);
  const previous = (retired.get(root) ?? Promise.resolve()).catch(
    () => undefined,
  );
  const bd = options.bd ?? createBdWatcher(root);
  const walks = new Map<SessionSource, Promise<string[]>>();
  const sources = shareDiscovery(options.sources ?? sessionSources, walks);
  const live: Live = {
    root,
    bd,
    // Created only after the stopped live's refresh ended, so two aggregators
    // never write the same state.json at once.
    aggregator: previous.then(() =>
      createAggregator({ ...options, root, bd, sources }),
    ),
    ready: Promise.resolve(),
    streams: new Set(),
    watchers: new Map(),
    timers: [],
    signature: '',
    head: '',
    queue: Promise.resolve(),
    scheduled: false,
    debounce: null,
    discovered: null,
    changeFiles: new Set(),
    rechecked: new Set(),
    walks,
    sources,
    stopped: false,
  };
  live.ready = (async () => {
    const aggregator = await live.aggregator;
    const observed = await observe(live);
    live.signature = observed.signature;
    live.head = observed.head;
    await exclusive(live, () => aggregator.refresh());
    live.timers.push(
      setInterval(() => {
        // The poll is the safety net for a store directory nobody watches yet.
        live.walks.clear();
        live.rechecked.clear();
        trigger(live);
      }, options.pollMs ?? 5_000),
      setInterval(
        () => broadcast(live, ': heartbeat\n\n'),
        options.heartbeatMs ?? 15_000,
      ),
    );
    for (const timer of live.timers) timer.unref();
  })().catch((error: unknown) => {
    stopLive(live);
    throw error;
  });
  lives.set(root, live);
  return live;
}

async function liveFor(root: string): Promise<Live> {
  const live = lives.get(root) ?? startLive(root);
  await live.ready;
  return live;
}

function send(
  res: ServerResponse,
  status: number,
  contentType: string,
  body: string,
  headOnly: boolean,
): void {
  res.statusCode = status;
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Length', Buffer.byteLength(body));
  res.end(headOnly ? undefined : body);
}

async function sendDashboard(
  res: ServerResponse,
  clientDir: string,
  headOnly: boolean,
): Promise<void> {
  try {
    const html = rewriteClientAssetUrls(
      await readFile(join(clientDir, 'usage.html'), 'utf8'),
      '/',
    );
    res.setHeader('Cache-Control', 'no-cache');
    send(res, 200, 'text/html; charset=utf-8', html, headOnly);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    send(res, 404, 'text/plain; charset=utf-8', 'Not found', headOnly);
  }
}

async function openStream(
  req: IncomingMessage,
  res: ServerResponse,
  root: string,
  headOnly: boolean,
): Promise<void> {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  if (headOnly) {
    res.end();
    return;
  }
  const live = await liveFor(root);
  if (req.destroyed) return;
  live.streams.add(res);
  res.write(
    `retry: 1000\nevent: ready\ndata: ${JSON.stringify({ instanceId })}\n\n`,
  );
  res.once('close', () => {
    live.streams.delete(res);
    if (live.streams.size === 0) stopLive(live);
  });
}

/**
 * The single dispatch line of the view server. Returns true when it answered
 * the request: the dashboard page, the event stream or a registered route.
 */
export async function handleUsage(
  req: IncomingMessage,
  res: ServerResponse,
  root: string,
  clientDir: string,
): Promise<boolean> {
  const method = req.method ?? 'GET';
  if (method !== 'GET' && method !== 'HEAD') return false;
  const headOnly = method === 'HEAD';
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  const { pathname } = url;
  if (pathname === '/_usage' || pathname.startsWith('/_usage/')) {
    await sendDashboard(res, clientDir, headOnly);
    return true;
  }
  if (pathname === EVENTS_PATH) {
    await openStream(req, res, root, headOnly);
    return true;
  }
  const route = routes.get(pathname);
  if (!route) return false;
  res.setHeader('Cache-Control', 'no-store');
  let filters: UsageFilters;
  try {
    filters = parseUsageFilters(url.searchParams);
  } catch (error) {
    const message = (error as Error).message;
    send(
      res,
      400,
      'application/json; charset=utf-8',
      JSON.stringify({ error: message }),
      headOnly,
    );
    return true;
  }
  const live = await liveFor(root);
  const aggregator = await live.aggregator;
  await exclusive(live, () => aggregator.refresh());
  const value = await route({
    root,
    url,
    filters,
    aggregator,
    bd: live.bd,
    sources: live.sources,
  });
  send(
    res,
    200,
    'application/json; charset=utf-8',
    JSON.stringify(value),
    headOnly,
  );
  return true;
}

async function usageAggregate({ filters, aggregator }: UsageRouteContext) {
  const { sessions: _sessions, ...overview } =
    await aggregator.summary(filters);
  return { schema_version: USAGE_SCHEMA_VERSION, ...overview };
}

async function usageSessions({ filters, aggregator }: UsageRouteContext) {
  const { sessions } = await aggregator.summary(filters);
  return { schema_version: USAGE_SCHEMA_VERSION, sessions };
}

// ROUTES: append one registerUsageRoute line per route below this line.
registerUsageRoute('/api/usage', usageAggregate);
registerUsageRoute('/api/usage/sessions', usageSessions);
registerUsageRoute('/api/usage/raw', rawEventsRoute);
registerUsageRoute('/api/usage/findings', findingsRoute);
