// @lat: [[usage-cli#Usage CLI]]
import { existsSync, readdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type { Command } from 'commander';
import { resolveContext } from '@plebeiantech/lat.md-core/cli/context';
import {
  createAggregator,
  type AggregatorOptions,
  type CountedSum,
  type UsageSummary,
} from './aggregate.js';
import { parseUsageFilters } from './filters.js';
import {
  ensureUsageDirectory,
  isSymlink,
  usageDirectory,
  usageEnabled,
} from './enabled.js';
import { USAGE_SCHEMA_VERSION } from './schema.js';
import type { SavingsEstimate } from './savings.js';
import {
  printNotEnabled,
  registerUsageGapsCommand,
  terminalSafe,
} from './usage-gaps-cli.js';

const ISSUE_LINES = 10;

type UsageOptions = {
  agent?: string;
  session?: string;
  issue?: string;
  since?: string;
  json?: boolean;
};

function disabledDirectory(root: string): string {
  return join(root, '.lat', 'usage.disabled');
}

function eventFileCount(dir: string): string {
  try {
    return String(
      readdirSync(dir).filter((name) => name.endsWith('.jsonl')).length,
    );
  } catch {
    return 'unknown';
  }
}

/** Renames the directory; on failure prints both paths and sets exit code 1. */
function moveDirectory(from: string, to: string): boolean {
  try {
    renameSync(from, to);
    return true;
  } catch (error) {
    console.log(
      `Could not move ${from} to ${to}: ${(error as Error).message}. Nothing was changed.`,
    );
    process.exitCode = 1;
    return false;
  }
}

/** Writers write nothing through a symlinked `.lat` or `.lat/usage`. */
function trackingState(root: string): string {
  return usageEnabled(root)
    ? 'Usage tracking is on.'
    : 'Usage tracking is off.';
}

/** A cloned repository can plant these as symlinks pointing outside it. */
function plantedSymlink(root: string): string | undefined {
  return [
    join(root, '.lat'),
    usageDirectory(root),
    disabledDirectory(root),
  ].find(isSymlink);
}

function enableUsage(root: string): void {
  const active = usageDirectory(root);
  const kept = disabledDirectory(root);
  const link = plantedSymlink(root);
  if (link !== undefined) {
    console.log(
      `Not enabled: ${link} is a symlink. Remove it, then run again.`,
    );
    process.exitCode = 1;
    return;
  }
  if (existsSync(active)) {
    ensureUsageDirectory(root);
    console.log(`Already enabled. ${trackingState(root)}`);
    if (existsSync(kept)) {
      console.log(`Older events stay in ${kept}; move them by hand to merge.`);
    }
    return;
  }
  if (existsSync(kept)) {
    if (!moveDirectory(kept, active)) return;
    ensureUsageDirectory(root);
    console.log(
      `Restored ${eventFileCount(active)} event files from .lat/usage.disabled.`,
    );
  } else {
    ensureUsageDirectory(root);
  }
  console.log(trackingState(root));
}

function disableUsage(root: string): void {
  const active = usageDirectory(root);
  const kept = disabledDirectory(root);
  const link = plantedSymlink(root);
  if (link !== undefined) {
    console.log(
      `Not disabled: ${link} is a symlink. Remove it, then run again.`,
    );
    process.exitCode = 1;
    return;
  }
  if (existsSync(active)) {
    if (existsSync(kept)) {
      console.log(
        `Not disabled: ${kept} already exists. Move or delete it, then run again.`,
      );
      process.exitCode = 1;
      return;
    }
    if (!moveDirectory(active, kept)) return;
    console.log(
      `Kept ${eventFileCount(kept)} event files in .lat/usage.disabled.`,
    );
  }
  console.log(
    usageEnabled(root)
      ? 'Usage tracking is off for this project, but LAT_USAGE=1 still enables it.'
      : trackingState(root),
  );
}

function counted(sum: CountedSum): string {
  if (sum.total === null) return 'unknown';
  return sum.unknown > 0
    ? `${sum.total} (+${sum.unknown} unknown)`
    : String(sum.total);
}

export type SavingsView =
  | {
      range: { low: number; point: number; high: number };
      method_version: number;
      label: string;
    }
  | { range: null; reason: string };

/** The net tokens saved of a summary: a labelled range, or why it is unknown. */
export function savingsOf(summary: UsageSummary): SavingsView {
  const savings = summary.extensions.savings as
    | SavingsEstimate
    | { error: string }
    | undefined;
  if (!savings || 'error' in savings) {
    return {
      range: null,
      reason:
        savings?.error ??
        summary.signals.net_tokens_saved_reason ??
        'no estimate',
    };
  }
  if (savings.net_tokens_saved === null) {
    return { range: null, reason: savings.reason ?? 'no estimate' };
  }
  return {
    range: savings.net_tokens_saved,
    method_version: savings.method_version,
    label: savings.label,
  };
}

function savingsLine(summary: UsageSummary): string {
  const savings = savingsOf(summary);
  if (savings.range === null) {
    return `Tokens saved: unknown (${savings.reason})`;
  }
  const { low, point, high } = savings.range;
  return `Tokens saved: ${low} to ${high} (point ${point}), method v${savings.method_version}, ${savings.label}`;
}

export function renderUsageSummary(summary: UsageSummary): string {
  const { totals } = summary;
  const lines = [
    `Commands: ${totals.commands}  Sessions: ${totals.sessions}  Errors: ${totals.errors}`,
    `Searches: ${totals.searches} (zero results: ${totals.zero_result_searches}, results unknown: ${totals.searches_unknown_results})`,
    `Section reads: ${totals.section_reads}  Bypass reads: ${totals.bypass_reads}`,
    `Injected bytes: ${counted(totals.injected_bytes)}`,
    `Input tokens: ${counted(totals.tokens.input)}  Output tokens: ${counted(totals.tokens.output)}`,
    savingsLine(summary),
  ];
  if (summary.issues.length > 0) {
    lines.push('Issues (rows overlap; not additive):');
    for (const row of summary.issues.slice(0, ISSUE_LINES)) {
      lines.push(
        `  ${terminalSafe(row.key)}  commands ${row.totals.commands}, rolled up ${row.rolled_up.totals.commands}`,
      );
    }
    const hidden = summary.issues.length - ISSUE_LINES;
    if (hidden > 0) lines.push(`  ... ${hidden} more (use --json)`);
  }
  return lines.join('\n') + '\n';
}

async function showUsage(
  program: Command,
  options: UsageOptions,
  aggregatorOptions: Partial<AggregatorOptions>,
): Promise<void> {
  const { projectRoot } = resolveContext(program.opts());
  const filters = parseUsageFilters({
    agent: options.agent,
    session: options.session,
    issue: options.issue,
    from: options.since,
  });
  if (!usageEnabled(projectRoot)) {
    printNotEnabled(options.json);
    return;
  }
  const aggregator = await createAggregator({
    ...aggregatorOptions,
    root: projectRoot,
  });
  const summary = await aggregator.summary(filters);
  if (options.json) {
    const full = { schema_version: USAGE_SCHEMA_VERSION, ...summary };
    process.stdout.write(JSON.stringify(full, null, 2) + '\n');
    return;
  }
  process.stdout.write(renderUsageSummary(summary));
}

export function registerUsageCommand(
  program: Command,
  aggregatorOptions: Partial<AggregatorOptions> = {},
): void {
  const usage = program
    .command('usage')
    .description('Show usage totals; enable or disable usage tracking')
    .option('--agent <name>', 'only this agent')
    .option('--session <id>', 'only this session id or name')
    .option('--issue <id>', 'only this bd issue, with its descendants')
    .option('--since <date>', 'only events from this ISO date on')
    .option('--json', 'print the full aggregate as JSON')
    .action((options: UsageOptions) =>
      showUsage(program, options, aggregatorOptions),
    );

  usage
    .command('enable')
    .description('Start recording usage under .lat/usage/')
    .action(() => enableUsage(resolveContext(program.opts()).projectRoot));
  usage
    .command('disable')
    .description('Stop recording; keeps the events in .lat/usage.disabled/')
    .action(() => disableUsage(resolveContext(program.opts()).projectRoot));
  registerUsageGapsCommand(usage, program, aggregatorOptions);
}
