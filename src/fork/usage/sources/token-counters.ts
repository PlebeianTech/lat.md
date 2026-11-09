import type { TokenUsage } from '../schema.js';

// @lat: [[usage-analytics#Usage Analytics#Session event#Token usage]]

type Counter = 'input' | 'output' | 'cache_read' | 'cache_write' | 'reasoning';

export type CounterValues = Record<Counter, unknown>;

/** Null when the value is not a finite number. */
export function reported(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function tokenCounters(values: CounterValues): TokenUsage {
  const usage = {} as TokenUsage;
  const reasons: NonNullable<TokenUsage['unknown_reasons']> = {};
  for (const counter of Object.keys(values) as Counter[]) {
    const value = reported(values[counter]);
    usage[counter] = value;
    if (value === null) reasons[counter] = 'unsupported_by_agent';
  }
  if (Object.keys(reasons).length > 0) usage.unknown_reasons = reasons;
  return usage;
}

export function reportedTotal(usage: TokenUsage): number {
  return (
    (usage.input ?? 0) +
    (usage.output ?? 0) +
    (usage.cache_read ?? 0) +
    (usage.cache_write ?? 0)
  );
}
