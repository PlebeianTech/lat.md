import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { createAggregator } from './aggregate.js';
import type { UsageSummary } from './aggregate-types.js';
import { parseUsageFilters } from './filters.js';
import { realUsageDirectory } from './enabled.js';
import { findingsRoute } from './findings.js';
import { USAGE_SCHEMA_VERSION } from './schema.js';
import { savingsOf } from './usage-cli.js';

/** Keeps what an agent reads into its context small. */
const MAX_FINDINGS = 10;
const MAX_EVIDENCE_LINES = 5;
const MAX_ISSUE_ROWS = 10;

const DISABLED_REASON =
  'Usage tracking is off for this project. Run `lat usage enable` to turn it on.';

const DESCRIPTION =
  'Show how lat is used in this project: totals, health signals and an estimated token saving (view "summary"), or ranked problems such as empty searches and files read around lat (view "findings"). All arguments are optional filters.';

function summaryView(summary: UsageSummary) {
  return {
    schema_version: USAGE_SCHEMA_VERSION,
    view: 'summary',
    filters: summary.filters,
    totals: summary.totals,
    signals: summary.signals,
    savings: savingsOf(summary),
    issues_note: 'Issue rows overlap and are not additive.',
    issues_total: summary.issues.length,
    issues: summary.issues.slice(0, MAX_ISSUE_ROWS).map((row) => ({
      key: row.key,
      status: row.status,
      totals: row.totals,
      rolled_up: row.rolled_up.totals,
    })),
  };
}

function text(value: unknown, isError = false) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
    ...(isError ? { isError: true } : {}),
  };
}

/**
 * Registers `lat_usage` when `.lat/usage` is a real directory. A symlinked one
 * from a cloned repository does not count, as with `usageEnabled`.
 */
export function registerUsageTool(
  server: McpServer,
  projectRoot: () => string | null,
): void {
  const startRoot = projectRoot();
  if (!startRoot || realUsageDirectory(startRoot) === null) return;

  server.tool(
    'lat_usage',
    DESCRIPTION,
    {
      agent: z.string().optional().describe('Only this agent'),
      session: z.string().optional().describe('Only this session id or name'),
      issue: z
        .string()
        .optional()
        .describe('Only this bd issue, with its descendants'),
      since: z.string().optional().describe('Only events from this ISO date'),
      view: z
        .enum(['summary', 'findings'])
        .optional()
        .describe('Default summary'),
    },
    async ({ agent, session, issue, since, view = 'summary' }) => {
      try {
        const root = projectRoot();
        if (!root || realUsageDirectory(root) === null)
          return text({ view, empty: true, reason: DISABLED_REASON });
        const filters = parseUsageFilters({
          agent,
          session,
          issue,
          from: since,
        });
        const aggregator = await createAggregator({ root });
        if (view === 'summary')
          return text(summaryView(await aggregator.summary(filters)));
        const result = await findingsRoute({
          root,
          filters,
          aggregator,
          url: new URL('http://localhost/api/usage/findings'),
        });
        return text({
          schema_version: USAGE_SCHEMA_VERSION,
          view,
          findings_total: result.findings.length,
          findings: result.findings.slice(0, MAX_FINDINGS).map((finding) => ({
            ...finding,
            evidence: finding.evidence.slice(0, MAX_EVIDENCE_LINES),
          })),
          errors: result.errors,
        });
      } catch (error) {
        return text(
          { error: error instanceof Error ? error.message : String(error) },
          true,
        );
      }
    },
  );
}
