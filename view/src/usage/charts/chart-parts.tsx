import type { CSSProperties, ReactElement } from 'react';

/** Colors are CSS tokens from usage.css, never hex values. */
export const DEFAULT_COLOR = 'var(--heat-4)';

// @lat: [[usage-dashboard-charts#Usage Dashboard Charts#The hidden table cannot widen the page]]
const HIDDEN: CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  margin: -1,
  padding: 0,
  border: 0,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
};

export const MUTED_TEXT: CSSProperties = { fill: 'var(--muted)', fontSize: 10 };
export const BODY_TEXT: CSSProperties = { fill: 'var(--text)', fontSize: 11 };
export const AXIS_LINE: CSSProperties = { stroke: 'var(--panel-border)' };

/** Unknown is unknown: null never reads as zero. */
export function formatValue(value: number | null | undefined): string {
  return value === null || value === undefined
    ? 'unknown'
    : value.toLocaleString('en-US');
}

/** Cuts text to `max` characters with an ellipsis; callers keep the full text in a title. */
export function shorten(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Maps a value to 0..1 over [min, max]; a degenerate domain maps to the middle. */
export function unitScale(min: number, max: number): (value: number) => number {
  return (value) => (max === min ? 0.5 : (value - min) / (max - min));
}

export function EmptyChart({
  label,
  detail,
}: {
  label: string;
  detail?: string;
}): ReactElement {
  return (
    <p className="chart-empty" style={{ color: 'var(--muted)', margin: 0 }}>
      {label}: no data{detail ? `. ${detail}` : ''}
    </p>
  );
}

/** The accessible name, the drawing (hidden from assistive tech) and its text equivalent. */
export function ChartFrame({
  label,
  head,
  rows,
  children,
}: {
  label: string;
  head: string[];
  rows: string[][];
  children: ReactElement | ReactElement[];
}): ReactElement {
  return (
    <div
      role="group"
      aria-label={label}
      style={{
        position: 'relative',
        display: 'block',
        maxWidth: '100%',
      }}
    >
      {children}
      <div style={HIDDEN}>
        <table>
          <caption>{label}</caption>
          <thead>
            <tr>
              {head.map((name) => (
                <th key={name}>{name}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={index}>
                {row.map((cell, column) => (
                  <td key={column}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
