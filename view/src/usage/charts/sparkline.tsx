import type { ReactElement } from 'react';
import {
  DEFAULT_COLOR,
  EmptyChart,
  formatValue,
  unitScale,
} from './chart-parts';

export interface SparklinePoint {
  day: string;
  value: number | null;
}

const WIDTH = 120;
const HEIGHT = 28;
const PAD = 3;

/**
 * The text alternative is one label, not a table, because a sparkline sits in
 * a table cell and a nested table would be announced row by row.
 */
function summary(label: string, points: SparklinePoint[]): string {
  const known = points.flatMap((point) =>
    point.value === null ? [] : [point.value],
  );
  const days = `${points.length} ${points.length === 1 ? 'day' : 'days'}`;
  const unknown = points.length - known.length;
  if (known.length === 0) return `${label}: ${days}, all unknown`;
  const last = formatValue(points[points.length - 1].value);
  return `${label}: ${days}, min ${formatValue(Math.min(...known))}, max ${formatValue(Math.max(...known))}, last ${last}, ${unknown} unknown`;
}

/** A daily series as a line with no axes. A null day is a gap. */
export function Sparkline({
  label,
  points,
  color = DEFAULT_COLOR,
}: {
  label: string;
  points: SparklinePoint[];
  color?: string;
}): ReactElement {
  if (points.length === 0) return <EmptyChart label={label} />;
  const known = points.flatMap((point) =>
    point.value === null ? [] : [point.value],
  );
  const toUnit = unitScale(Math.min(...known), Math.max(...known));
  const runs: { x: number; y: number }[][] = [];
  let open = false;
  points.forEach((point, index) => {
    if (point.value === null) {
      open = false;
      return;
    }
    const x =
      points.length === 1
        ? WIDTH / 2
        : PAD + (index / (points.length - 1)) * (WIDTH - 2 * PAD);
    const y = HEIGHT - PAD - toUnit(point.value) * (HEIGHT - 2 * PAD);
    if (!open) runs.push([]);
    runs[runs.length - 1].push({ x, y });
    open = true;
  });
  return (
    <span
      role="img"
      aria-label={summary(label, points)}
      style={{ display: 'inline-block', maxWidth: '100%' }}
    >
      <svg
        aria-hidden="true"
        focusable="false"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        width={WIDTH}
        height={HEIGHT}
        style={{ display: 'block', maxWidth: '100%' }}
      >
        {runs.map((run, index) =>
          run.length === 1 ? (
            <circle
              key={index}
              data-mark="dot"
              cx={run[0].x}
              cy={run[0].y}
              r={2}
              style={{ fill: color }}
            />
          ) : (
            <path
              key={index}
              data-mark="line"
              d={run
                .map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x} ${p.y}`)
                .join(' ')}
              style={{ fill: 'none', stroke: color, strokeWidth: 2 }}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          ),
        )}
      </svg>
    </span>
  );
}
