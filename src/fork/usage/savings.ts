/**
 * Estimate of the tokens lat saved, net of the tokens its hooks injected.
 *
 * A section read saves the bytes of its whole document, taken from the graph
 * snapshot at the event's git head, minus the bytes the command printed. A
 * hook event costs its injected bytes and saves nothing. Bytes become tokens
 * at read time with a low, a point and a high bytes-per-token ratio, so the
 * result is a range. It shows a correlation, not a cause: no holdout runs.
 *
 * Rows take the point estimate through `netTokensSaved`, which is synchronous,
 * so `prepare` loads the snapshots before the rows are built.
 */
import {
  isSectionRead,
  Sum,
  type AggregateContext,
  type CountedSum,
  type Contribution,
  type Item,
} from './aggregate-types.js';
import { snapshotAt, type SnapshotResult } from './graph-snapshot.js';
import type { UsageEvent } from './schema.js';

export const SAVINGS_METHOD_VERSION = 1;

/** Bytes per token: the fewest, the typical and the most. */
export const BYTES_PER_TOKEN = { low: 3, point: 4, high: 5 };

export interface TokenRange {
  low: number;
  point: number;
  high: number;
}

export interface SavingsEstimate {
  method_version: number;
  label: 'correlation, not cause';
  bytes_per_token: typeof BYTES_PER_TOKEN;
  /** Section reads in the items, known or not. */
  reads: number;
  /** Per read: document bytes minus bytes_out. Unknown reads are not added. */
  saved_bytes: CountedSum;
  /** Per hook event: injected_bytes. */
  injected_bytes: CountedSum;
  unknown_reads: { reason: string; count: number }[];
  /** Null when every input is unknown. */
  net_tokens_saved: TokenRange | null;
  /** Why the net is null; null otherwise. */
  reason: string | null;
}

/** Snapshot results by project root and head, filled by prepare. */
const loaded = new Map<string, SnapshotResult>();
const loadedKey = (root: string, head: string) => `${root}\0${head}`;

type Saved = { bytes: number } | { reason: string };

function savedBytes(usage: UsageEvent, root: string): Saved {
  if (usage.bytes_out === null) return { reason: 'bytes_out not captured' };
  if (!usage.git_head) return { reason: 'git_head not captured' };
  const result = loaded.get(loadedKey(root, usage.git_head));
  if (!result) {
    return { reason: `snapshot of ${usage.git_head} not loaded` };
  }
  if (!result.snapshot) {
    return {
      reason: `no snapshot of ${usage.git_head}: ${result.reason}`,
    };
  }
  const section = result.snapshot.sections.find(
    (candidate) => candidate.id === usage.section_id,
  );
  const document = section
    ? result.snapshot.documents.find((d) => d.path === section.document)
    : undefined;
  if (!document) {
    return { reason: `section ${usage.section_id} not in the snapshot` };
  }
  return { bytes: document.bytes - usage.bytes_out };
}

export function estimateSavings(items: Item[], root: string): SavingsEstimate {
  const saved = new Sum();
  const injected = new Sum();
  const unknown = new Map<string, number>();
  let reads = 0;
  for (const item of items) {
    const usage = item.usage;
    if (!usage) continue;
    if (usage.caller === 'hook-injected') {
      injected.add(usage.injected_bytes);
      if (usage.injected_bytes === null) {
        const reason = 'injected_bytes not captured';
        unknown.set(reason, (unknown.get(reason) ?? 0) + 1);
      }
      continue;
    }
    if (!isSectionRead(item)) continue;
    reads++;
    const result = savedBytes(usage, root);
    if ('bytes' in result) saved.add(result.bytes);
    else {
      saved.add(null);
      unknown.set(result.reason, (unknown.get(result.reason) ?? 0) + 1);
    }
  }
  const savedResult = saved.result();
  const injectedResult = injected.result();
  const unknownReads = [...unknown]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => a.reason.localeCompare(b.reason));
  const hooks = injectedResult.known + injectedResult.unknown;
  const sideUnknown =
    (reads > 0 && savedResult.known === 0) ||
    (hooks > 0 && injectedResult.known === 0);
  const reason = sideUnknown
    ? `unknown: ${unknownReads.map((entry) => entry.reason).join('; ')}`
    : null;

  const savedTotal = savedResult.total ?? 0;
  const injectedTotal = injectedResult.total ?? 0;
  const { low, point, high } = BYTES_PER_TOKEN;
  const corners = [low, high].flatMap((savedRatio) =>
    [low, high].map(
      (injectedRatio) =>
        savedTotal / savedRatio - injectedTotal / injectedRatio,
    ),
  );
  return {
    method_version: SAVINGS_METHOD_VERSION,
    label: 'correlation, not cause',
    bytes_per_token: BYTES_PER_TOKEN,
    reads,
    saved_bytes: savedResult,
    injected_bytes: injectedResult,
    unknown_reads: unknownReads,
    net_tokens_saved: reason
      ? null
      : {
          low: Math.round(Math.min(...corners)),
          point: Math.round((savedTotal - injectedTotal) / point),
          high: Math.round(Math.max(...corners)),
        },
    reason,
  };
}

export const savingsContribution: Contribution = {
  key: 'savings',
  async prepare({ root, items }: AggregateContext) {
    const worktreesByHead = new Map<string, string[]>();
    for (const item of items) {
      const usage = item.usage;
      if (!usage?.git_head || !isSectionRead(item)) continue;
      const worktrees = worktreesByHead.get(usage.git_head) ?? [];
      if (usage.worktree && !worktrees.includes(usage.worktree)) {
        worktrees.push(usage.worktree);
      }
      worktreesByHead.set(usage.git_head, worktrees);
    }
    for (const [head, worktrees] of worktreesByHead) {
      loaded.set(
        loadedKey(root, head),
        await snapshotAt(root, head, worktrees),
      );
    }
  },
  compute({ root, items }: AggregateContext) {
    return estimateSavings(items, root);
  },
  netTokensSaved(items, { root }) {
    const estimate = estimateSavings(items, root);
    if (!estimate.net_tokens_saved) throw new Error(estimate.reason!);
    return estimate.net_tokens_saved.point;
  },
};
