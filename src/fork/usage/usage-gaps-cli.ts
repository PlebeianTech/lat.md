import type { Command } from 'commander';
import { resolveContext } from '@plebeiantech/lat.md-core/cli/context';
import { createAggregator, type AggregatorOptions } from './aggregate.js';
import { parseUsageFilters } from './filters.js';
import { NOT_ENABLED_MESSAGE, usageEnabled } from './enabled.js';
import { findingsFor, type Finding } from './findings.js';
import { USAGE_SCHEMA_VERSION } from './schema.js';

const GAP_LINES = 20;

type GapsOptions = {
  agent?: string;
  session?: string;
  issue?: string;
  since?: string;
  json?: boolean;
};

export function gapLine(finding: Finding): string {
  let line = `${finding.kind}  ${finding.subject}  count ${finding.count}, sessions ${finding.sessions}`;
  const { suggestion, expected_section_id } = finding;
  if (suggestion)
    line += `  closest: ${suggestion.title} (${suggestion.section_id})`;
  if (expected_section_id) line += `  expected: ${expected_section_id}`;
  return line;
}

export function printNotEnabled(json: boolean | undefined, extra = {}): void {
  if (json) {
    const body = {
      schema_version: USAGE_SCHEMA_VERSION,
      enabled: false,
      reason: NOT_ENABLED_MESSAGE,
      ...extra,
    };
    process.stdout.write(JSON.stringify(body, null, 2) + '\n');
  } else console.log(NOT_ENABLED_MESSAGE);
}

async function showGaps(
  program: Command,
  options: GapsOptions,
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
    printNotEnabled(options.json, { findings: [], errors: [] });
    return;
  }
  const sourceOptions = { ...aggregatorOptions, root: projectRoot };
  const aggregator = await createAggregator(sourceOptions);
  const result = await findingsFor(aggregator, filters, sourceOptions);
  if (options.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }
  const lines = result.errors.map(
    (error) => `Detector ${error.detector} failed: ${error.message}`,
  );
  lines.push(...result.findings.slice(0, GAP_LINES).map(gapLine));
  const hidden = result.findings.length - GAP_LINES;
  if (hidden > 0) lines.push(`... ${hidden} more (use --json)`);
  if (lines.length === 0) lines.push('No gaps found for these filters.');
  process.stdout.write(lines.join('\n') + '\n');
}

/** Registers `lat usage gaps`, a ranked to-do list over the usage findings. */
export function registerUsageGapsCommand(
  usage: Command,
  program: Command,
  aggregatorOptions: Partial<AggregatorOptions> = {},
): void {
  usage
    .command('gaps')
    .description('List ranked gaps found in usage: empty searches and more')
    .option('--agent <name>', 'only this agent')
    .option('--session <id>', 'only this session id or name')
    .option('--issue <id>', 'only this bd issue, with its descendants')
    .option('--since <date>', 'only events from this ISO date on')
    .option('--json', 'print the full finding records as JSON')
    // The parent `usage` command declares the same flags and takes them first.
    .action((_options: GapsOptions, command: Command) =>
      showGaps(program, command.optsWithGlobals(), aggregatorOptions),
    );
}
