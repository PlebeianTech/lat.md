import type { ReactElement } from 'react';
import {
  AXIS_LINE,
  BODY_TEXT,
  ChartFrame,
  DEFAULT_COLOR,
  EmptyChart,
  MUTED_TEXT,
  formatValue,
  shorten,
  unitScale,
} from './chart-parts';

export interface ValueRange {
  low: number;
  point: number;
  high: number;
}

const WIDTH = 320;
const LABEL_WIDTH = 120;
const ROW = 34;
const BAR_HEIGHT = 14;
const AXIS_ROOM = 18;
const MIN_WIDTH = 2;
const MAX_LABEL = 20;
const MAX_DETAIL = 24;

/** A low to high range with a point estimate, beside a cost bar, on one axis that includes zero. */
export function RangeBar({
  label,
  range,
  cost,
  rangeReason,
  rangeLabel = 'Net tokens saved',
  costLabel = 'Cost',
}: {
  label: string;
  range: ValueRange | null;
  cost: number | null;
  /** Why the range is unknown, shown as "unknown (reason)". */
  rangeReason?: string;
  rangeLabel?: string;
  costLabel?: string;
}): ReactElement {
  const unknownRange = `unknown${rangeReason ? ` (${rangeReason})` : ''}`;
  if (range === null && cost === null) {
    return (
      <EmptyChart label={label} detail={`${rangeLabel}: ${unknownRange}`} />
    );
  }
  const low = range ? Math.min(range.low, range.high) : 0;
  const high = range ? Math.max(range.low, range.high) : 0;
  const shared = [
    0,
    low,
    high,
    ...(range ? [range.point] : []),
    ...(cost === null ? [] : [cost]),
  ];
  const toUnit = unitScale(Math.min(...shared), Math.max(...shared));
  const span = WIDTH - LABEL_WIDTH - 8;
  const at = (value: number) => LABEL_WIDTH + toUnit(value) * span;
  const axisY = 2 * ROW;
  const rangeY = (ROW - BAR_HEIGHT) / 2;
  const costY = ROW + rangeY;
  const rangeText = range
    ? `${formatValue(low)} to ${formatValue(high)}, point ${formatValue(range.point)}`
    : unknownRange;
  return (
    <ChartFrame
      label={label}
      head={['Measure', 'Value']}
      rows={[
        [`${rangeLabel} low`, range ? formatValue(low) : unknownRange],
        [
          `${rangeLabel} point`,
          range ? formatValue(range.point) : unknownRange,
        ],
        [`${rangeLabel} high`, range ? formatValue(high) : unknownRange],
        [costLabel, formatValue(cost)],
      ]}
    >
      <svg
        aria-hidden="true"
        focusable="false"
        viewBox={`0 0 ${WIDTH} ${axisY + AXIS_ROOM}`}
        style={{ display: 'block', width: '100%', height: 'auto' }}
      >
        <text x={0} y={ROW / 2 - 4} style={BODY_TEXT}>
          {shorten(rangeLabel, MAX_LABEL)}
          <title>{rangeLabel}</title>
        </text>
        <text x={0} y={ROW / 2 + 9} style={MUTED_TEXT}>
          {shorten(rangeText, MAX_DETAIL)}
          <title>{rangeText}</title>
        </text>
        <text x={0} y={ROW + ROW / 2 - 4} style={BODY_TEXT}>
          {shorten(costLabel, MAX_LABEL)}
          <title>{costLabel}</title>
        </text>
        <text x={0} y={ROW + ROW / 2 + 9} style={MUTED_TEXT}>
          {formatValue(cost)}
        </text>
        {range && (
          <>
            <rect
              data-mark="range"
              x={at(low)}
              y={rangeY}
              width={Math.max(MIN_WIDTH, at(high) - at(low))}
              height={BAR_HEIGHT}
              rx={3}
              style={{ fill: DEFAULT_COLOR, opacity: 0.45 }}
            />
            <line
              data-mark="point"
              x1={at(range.point)}
              x2={at(range.point)}
              y1={rangeY - 2}
              y2={rangeY + BAR_HEIGHT + 2}
              style={{ stroke: DEFAULT_COLOR, strokeWidth: 3 }}
            />
          </>
        )}
        {cost !== null && (
          <rect
            data-mark="cost"
            x={Math.min(at(0), at(cost))}
            y={costY}
            width={Math.max(MIN_WIDTH, Math.abs(at(cost) - at(0)))}
            height={BAR_HEIGHT}
            rx={3}
            style={{ fill: 'var(--muted)' }}
          />
        )}
        <line
          data-mark="zero"
          x1={at(0)}
          x2={at(0)}
          y1={0}
          y2={axisY}
          style={AXIS_LINE}
        />
        <line
          x1={LABEL_WIDTH}
          x2={WIDTH - 8}
          y1={axisY}
          y2={axisY}
          style={AXIS_LINE}
        />
        <text
          x={at(Math.min(...shared))}
          y={axisY + 12}
          textAnchor="start"
          style={MUTED_TEXT}
        >
          {formatValue(Math.min(...shared))}
        </text>
        <text
          x={at(Math.max(...shared))}
          y={axisY + 12}
          textAnchor="end"
          style={MUTED_TEXT}
        >
          {formatValue(Math.max(...shared))}
        </text>
      </svg>
    </ChartFrame>
  );
}
