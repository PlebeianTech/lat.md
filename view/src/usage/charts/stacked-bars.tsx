import type { ReactElement } from 'react';
import {
  AXIS_LINE,
  ChartFrame,
  EmptyChart,
  MUTED_TEXT,
  formatValue,
  unitScale,
} from './chart-parts';

export interface StackSeries {
  key: string;
  label: string;
  color: string;
}

export interface StackedBar {
  label: string;
  /** Value per series key; a null or missing key is unknown. */
  values: Record<string, number | null>;
}

const WIDTH = 320;
const HEIGHT = 160;
const LEFT = 40;
const TOP = 12;
const BOTTOM = 20;
const MAX_LABELS = 6;

/** One column per category, stacked by series, with a legend. */
export function StackedBars({
  label,
  bars,
  series,
}: {
  label: string;
  bars: StackedBar[];
  series: StackSeries[];
}): ReactElement {
  if (bars.length === 0 || series.length === 0) {
    return <EmptyChart label={label} />;
  }
  const valueOf = (bar: StackedBar, key: string) => bar.values[key] ?? null;
  const stacks = bars.map((bar) => {
    let up = 0;
    let down = 0;
    const segments = series.flatMap((s) => {
      const value = valueOf(bar, s.key);
      if (value === null || value === 0) return [];
      const from = value > 0 ? up : down;
      if (value > 0) up += value;
      else down += value;
      return [{ series: s, from, to: from + value }];
    });
    return {
      bar,
      segments,
      up,
      down,
      unknown: series.some((s) => valueOf(bar, s.key) === null),
    };
  });
  const high = Math.max(0, ...stacks.map((stack) => stack.up));
  const low = Math.min(0, ...stacks.map((stack) => stack.down));
  const toUnit = unitScale(low, high);
  const plotHeight = HEIGHT - TOP - BOTTOM;
  const y = (value: number) => TOP + (1 - toUnit(value)) * plotHeight;
  const band = (WIDTH - LEFT) / bars.length;
  const barWidth = band * 0.7;
  const labelEvery = Math.ceil(bars.length / MAX_LABELS);
  return (
    <ChartFrame
      label={label}
      head={['Category', ...series.map((s) => s.label)]}
      rows={bars.map((bar) => [
        bar.label,
        ...series.map((s) => formatValue(valueOf(bar, s.key))),
      ])}
    >
      <svg
        aria-hidden="true"
        focusable="false"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        style={{ display: 'block', width: '100%', height: 'auto' }}
      >
        <line x1={LEFT} x2={WIDTH} y1={y(0)} y2={y(0)} style={AXIS_LINE} />
        <text
          x={LEFT - 4}
          y={y(high)}
          textAnchor="end"
          dominantBaseline="hanging"
          style={MUTED_TEXT}
        >
          {formatValue(high)}
        </text>
        <text
          x={LEFT - 4}
          y={y(0)}
          textAnchor="end"
          dominantBaseline="central"
          style={MUTED_TEXT}
        >
          0
        </text>
        {low < 0 && (
          <text
            x={LEFT - 4}
            y={y(low)}
            textAnchor="end"
            dominantBaseline="auto"
            style={MUTED_TEXT}
          >
            {formatValue(low)}
          </text>
        )}
        {stacks.map((stack, index) => {
          const left = LEFT + index * band + (band - barWidth) / 2;
          const centre = left + barWidth / 2;
          return (
            <g key={index}>
              {stack.segments.map(({ series: s, from, to }) => (
                <rect
                  key={s.key}
                  data-mark="segment"
                  data-series={s.key}
                  x={left}
                  y={Math.min(y(from), y(to))}
                  width={barWidth}
                  height={Math.abs(y(from) - y(to))}
                  style={{
                    fill: s.color,
                    stroke: 'var(--background)',
                    strokeWidth: 1,
                  }}
                />
              ))}
              {stack.unknown && (
                <text
                  data-mark="unknown"
                  x={centre}
                  y={y(stack.up) - 3}
                  textAnchor="middle"
                  style={MUTED_TEXT}
                >
                  ?
                </text>
              )}
              {index % labelEvery === 0 && (
                <text
                  x={centre}
                  y={HEIGHT - 6}
                  textAnchor="middle"
                  style={MUTED_TEXT}
                >
                  {stack.bar.label}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <ul
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '4px 12px',
          listStyle: 'none',
          margin: '4px 0 0',
          padding: 0,
          fontSize: 12,
        }}
      >
        {series.map((s) => (
          <li
            key={s.key}
            style={{ display: 'flex', alignItems: 'center', gap: 4 }}
          >
            <span
              aria-hidden="true"
              style={{
                width: 10,
                height: 10,
                borderRadius: 2,
                background: s.color,
              }}
            />
            {s.label}
          </li>
        ))}
      </ul>
    </ChartFrame>
  );
}
