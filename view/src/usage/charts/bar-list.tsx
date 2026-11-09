import type { ReactElement } from 'react';
import {
  BODY_TEXT,
  AXIS_LINE,
  ChartFrame,
  DEFAULT_COLOR,
  EmptyChart,
  formatValue,
  shorten,
  unitScale,
} from './chart-parts';

export interface BarListItem {
  label: string;
  value: number | null;
  color?: string;
}

const WIDTH = 320;
const LABEL_WIDTH = 120;
const VALUE_WIDTH = 60;
const ROW = 22;
const BAR_HEIGHT = 12;
const MAX_LABEL = 20;

/** Ranked horizontal bars, largest first, top `limit` only. Unknown ranks last with no bar. */
export function BarList({
  label,
  items,
  limit = 10,
}: {
  label: string;
  items: BarListItem[];
  limit?: number;
}): ReactElement {
  if (items.length === 0) return <EmptyChart label={label} />;
  const ranked = [
    ...items.filter((item) => item.value !== null),
    ...items.filter((item) => item.value === null),
  ].sort((a, b) => (b.value ?? -Infinity) - (a.value ?? -Infinity));
  const shown = ranked.slice(0, limit);
  const hidden = ranked.length - shown.length;
  const values = shown.flatMap((item) =>
    item.value === null ? [] : [item.value],
  );
  const toUnit = unitScale(Math.min(0, ...values), Math.max(0, ...values));
  const barLeft = LABEL_WIDTH;
  const barSpan = WIDTH - LABEL_WIDTH - VALUE_WIDTH;
  const at = (value: number) => barLeft + toUnit(value) * barSpan;
  const height = shown.length * ROW;
  return (
    <ChartFrame
      label={label}
      head={['Rank', 'Item', 'Value']}
      rows={shown.map((item, index) => [
        String(index + 1),
        item.label,
        formatValue(item.value),
      ])}
    >
      <svg
        aria-hidden="true"
        focusable="false"
        viewBox={`0 0 ${WIDTH} ${height}`}
        style={{ display: 'block', width: '100%', height: 'auto' }}
      >
        {shown.map((item, index) => {
          const top = index * ROW;
          const middle = top + ROW / 2;
          return (
            <g key={`${index}-${item.label}`}>
              <text
                x={0}
                y={middle}
                dominantBaseline="central"
                style={BODY_TEXT}
              >
                {shorten(item.label, MAX_LABEL)}
                <title>{item.label}</title>
              </text>
              {item.value !== null && (
                <rect
                  data-mark="bar"
                  x={Math.min(at(0), at(item.value))}
                  y={middle - BAR_HEIGHT / 2}
                  width={Math.abs(at(item.value) - at(0))}
                  height={BAR_HEIGHT}
                  rx={2}
                  style={{ fill: item.color ?? DEFAULT_COLOR }}
                />
              )}
              <text
                x={WIDTH}
                y={middle}
                textAnchor="end"
                dominantBaseline="central"
                style={BODY_TEXT}
              >
                {formatValue(item.value)}
              </text>
            </g>
          );
        })}
        <line x1={at(0)} x2={at(0)} y1={0} y2={height} style={AXIS_LINE} />
      </svg>
      {hidden > 0 ? (
        <p style={{ color: 'var(--muted)', margin: 0, fontSize: 12 }}>
          +{hidden} more not shown
        </p>
      ) : (
        <></>
      )}
    </ChartFrame>
  );
}
