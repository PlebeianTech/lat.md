import type { ReactElement } from 'react';
import {
  AXIS_LINE,
  BODY_TEXT,
  ChartFrame,
  DEFAULT_COLOR,
  EmptyChart,
  MUTED_TEXT,
  shorten,
  unitScale,
} from './chart-parts';

export interface TimelineEvent {
  id: string;
  label: string;
  /** Epoch milliseconds; null is unknown and is listed but not drawn. */
  start: number | null;
  /** Epoch milliseconds; absent makes the event an instant. */
  end?: number | null;
}

export interface TimelineLane {
  label: string;
  events: TimelineEvent[];
  color?: string;
}

const WIDTH = 320;
const LABEL_WIDTH = 80;
const ROW = 24;
const BAR_HEIGHT = 12;
const AXIS_ROOM = 16;
const MIN_WIDTH = 2;

const MAX_LANE_LABEL = 12;

const isValidTime = (ms: unknown): ms is number =>
  typeof ms === 'number' && !Number.isNaN(new Date(ms).getTime());

/** toISOString throws on NaN and out-of-range input, so anything invalid reads unknown. */
const iso = (ms: number | null | undefined): string =>
  isValidTime(ms) ? new Date(ms).toISOString().slice(0, 19) + 'Z' : 'unknown';

/** Events on a time axis in labelled lanes. */
export function TimelineLanes({
  label,
  lanes,
}: {
  label: string;
  lanes: TimelineLane[];
}): ReactElement {
  const events = lanes.flatMap((lane) => lane.events);
  if (events.length === 0) return <EmptyChart label={label} />;
  const spanOf = (event: TimelineEvent) => {
    if (!isValidTime(event.start)) return null;
    // Only an absent end is an instant; a null or invalid end is unknown.
    if (event.end === undefined) {
      return { from: event.start, to: event.start, openEnd: false };
    }
    if (!isValidTime(event.end)) {
      return { from: event.start, to: event.start, openEnd: true };
    }
    return {
      from: Math.min(event.start, event.end),
      to: Math.max(event.start, event.end),
      openEnd: false,
    };
  };
  const spans = events.flatMap((event) => spanOf(event) ?? []);
  const first = spans.length ? Math.min(...spans.map((s) => s.from)) : 0;
  const last = spans.length ? Math.max(...spans.map((s) => s.to)) : 0;
  const toUnit = unitScale(first, last);
  const plot = WIDTH - LABEL_WIDTH - 6;
  const at = (ms: number) => LABEL_WIDTH + toUnit(ms) * plot;
  const axisY = lanes.length * ROW;
  const unknownCount = events.length - spans.length;
  return (
    <ChartFrame
      label={label}
      head={['Lane', 'Event', 'Label', 'Start', 'End']}
      rows={lanes.flatMap((lane) =>
        lane.events.map((event) => [
          lane.label,
          event.id,
          event.label,
          iso(event.start),
          !isValidTime(event.start)
            ? 'unknown'
            : event.end === undefined
              ? iso(event.start)
              : iso(event.end),
        ]),
      )}
    >
      <svg
        aria-hidden="true"
        focusable="false"
        viewBox={`0 0 ${WIDTH} ${axisY + AXIS_ROOM}`}
        style={{ display: 'block', width: '100%', height: 'auto' }}
      >
        {lanes.map((lane, index) => {
          const middle = index * ROW + ROW / 2;
          const color = lane.color ?? DEFAULT_COLOR;
          return (
            <g key={index}>
              <text
                x={0}
                y={middle}
                dominantBaseline="central"
                style={BODY_TEXT}
              >
                {shorten(lane.label, MAX_LANE_LABEL)}
                <title>{lane.label}</title>
              </text>
              <line
                x1={LABEL_WIDTH}
                x2={WIDTH - 6}
                y1={middle}
                y2={middle}
                style={AXIS_LINE}
              />
              {lane.events.map((event) => {
                const span = spanOf(event);
                if (!span) return null;
                if (span.openEnd) {
                  return (
                    <rect
                      key={event.id}
                      data-mark="event"
                      data-end="unknown"
                      x={at(span.from)}
                      y={middle - BAR_HEIGHT / 2}
                      width={Math.max(MIN_WIDTH, WIDTH - 6 - at(span.from))}
                      height={BAR_HEIGHT}
                      rx={2}
                      strokeDasharray="4 3"
                      style={{ fill: 'none', stroke: color, strokeWidth: 2 }}
                    >
                      <title>{event.label} (end unknown)</title>
                    </rect>
                  );
                }
                const instant = span.from === span.to;
                return instant ? (
                  <circle
                    key={event.id}
                    data-mark="event"
                    cx={at(span.from)}
                    cy={middle}
                    r={4}
                    style={{
                      fill: color,
                      stroke: 'var(--background)',
                      strokeWidth: 2,
                    }}
                  >
                    <title>{event.label}</title>
                  </circle>
                ) : (
                  <rect
                    key={event.id}
                    data-mark="event"
                    x={at(span.from)}
                    y={middle - BAR_HEIGHT / 2}
                    width={Math.max(MIN_WIDTH, at(span.to) - at(span.from))}
                    height={BAR_HEIGHT}
                    rx={2}
                    style={{ fill: color }}
                  >
                    <title>{event.label}</title>
                  </rect>
                );
              })}
            </g>
          );
        })}
        <line
          x1={LABEL_WIDTH}
          x2={WIDTH - 6}
          y1={axisY}
          y2={axisY}
          style={AXIS_LINE}
        />
        {spans.length > 0 && (
          <>
            <text
              x={LABEL_WIDTH}
              y={axisY + 11}
              textAnchor="start"
              style={MUTED_TEXT}
            >
              {iso(first)}
            </text>
            <text
              x={WIDTH - 6}
              y={axisY + 11}
              textAnchor="end"
              style={MUTED_TEXT}
            >
              {first === last ? '' : iso(last)}
            </text>
          </>
        )}
      </svg>
      {unknownCount > 0 ? (
        <p style={{ color: 'var(--muted)', margin: 0, fontSize: 12 }}>
          {unknownCount} {unknownCount === 1 ? 'event' : 'events'} with unknown
          time not drawn
        </p>
      ) : (
        <></>
      )}
    </ChartFrame>
  );
}
