// @vitest-environment jsdom
/// <reference types="vite/client" />
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Sparkline } from '../view/src/usage/charts/sparkline';
import { BarList } from '../view/src/usage/charts/bar-list';
import { StackedBars } from '../view/src/usage/charts/stacked-bars';
import { RangeBar } from '../view/src/usage/charts/range-bar';
import { TimelineLanes } from '../view/src/usage/charts/timeline-lanes';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const days = (...values: (number | null)[]) =>
  values.map((value, index) => ({ day: `2026-01-0${index + 1}`, value }));

describe('usage dashboard charts', () => {
  let root: Root;
  let container: HTMLDivElement;

  async function render(element: ReactElement): Promise<void> {
    await act(async () => root.render(element));
  }
  const marks = (kind: string) =>
    container.querySelectorAll(`[data-mark="${kind}"]`);
  const num = (element: Element, name: string) =>
    Number(element.getAttribute(name));
  const tableCells = () =>
    [...container.querySelectorAll('table tr')].map((row) =>
      [...row.querySelectorAll('th,td')].map((cell) => cell.textContent),
    );
  const summaryOf = () =>
    container.querySelector('[role="img"]')!.getAttribute('aria-label');
  const tableText = () => container.querySelector('table')?.textContent ?? '';

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  // @lat: [[usage-dashboard-charts#Usage Dashboard Charts#Sparkline draws one line per run of known days]]
  it('draws one line for a series and keeps extremes inside the box', async () => {
    await render(
      createElement(Sparkline, { label: 'Reads', points: days(1, 5, 3, 9) }),
    );
    expect(marks('line')).toHaveLength(1);
    const svg = container.querySelector('svg')!;
    const height = svg.viewBox.baseVal.height;
    const ys = marks('line')[0]
      .getAttribute('d')!
      .match(/-?\d+(\.\d+)?/g)!
      .map(Number)
      .filter((_, index) => index % 2 === 1);
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...ys)).toBeLessThanOrEqual(height);
    expect(ys[3]).toBe(Math.min(...ys));
    expect(ys[0]).toBe(Math.max(...ys));
  });

  it('draws a finite line for a flat series', async () => {
    await render(
      createElement(Sparkline, { label: 'Reads', points: days(4, 4, 4) }),
    );
    expect(marks('line')[0].getAttribute('d')).not.toMatch(/NaN|Infinity/);
  });

  // @lat: [[usage-dashboard-charts#Usage Dashboard Charts#Sparkline leaves unknown days as gaps]]
  it('splits the line at an unknown day and never draws it as zero', async () => {
    await render(
      createElement(Sparkline, {
        label: 'Reads',
        points: days(2, 3, null, 4, 5, 6),
      }),
    );
    expect(marks('line')).toHaveLength(2);
    expect(marks('dot')).toHaveLength(0);
    expect(summaryOf()).toContain('1 unknown');
    expect(container.querySelector('table')).toBeNull();
  });

  it('draws a run of one known day as a dot', async () => {
    await render(
      createElement(Sparkline, {
        label: 'Reads',
        points: days(2, 3, null, 4, null, 5, 6),
      }),
    );
    expect(marks('line')).toHaveLength(2);
    expect(marks('dot')).toHaveLength(1);
  });

  it('summarises the series in one label with no nested table', async () => {
    await render(
      createElement(Sparkline, {
        label: 'Reads',
        points: days(3, null, 1200, 5, null),
      }),
    );
    expect(summaryOf()).toBe(
      'Reads: 5 days, min 3, max 1,200, last unknown, 2 unknown',
    );
    expect(container.querySelector('table')).toBeNull();
    expect(container.querySelector('svg')!.getAttribute('aria-hidden')).toBe(
      'true',
    );
  });

  it('says all unknown when no day is known', async () => {
    await render(
      createElement(Sparkline, { label: 'Reads', points: days(null, null) }),
    );
    expect(summaryOf()).toBe('Reads: 2 days, all unknown');
    expect(marks('line')).toHaveLength(0);
    expect(marks('dot')).toHaveLength(0);
  });

  // @lat: [[usage-dashboard-charts#Usage Dashboard Charts#Sparkline with one point draws a dot]]
  it('draws one dot and no line for a single point', async () => {
    await render(createElement(Sparkline, { label: 'Reads', points: days(7) }));
    expect(marks('dot')).toHaveLength(1);
    expect(marks('line')).toHaveLength(0);
    expect(summaryOf()).toBe('Reads: 1 day, min 7, max 7, last 7, 0 unknown');
  });

  // @lat: [[usage-dashboard-charts#Usage Dashboard Charts#Bar list ranks and limits]]
  it('ranks items, keeps the top N and counts the rest', async () => {
    await render(
      createElement(BarList, {
        label: 'Top sections',
        limit: 2,
        items: [
          { label: 'b', value: 5 },
          { label: 'unk', value: null },
          { label: 'a', value: 9 },
          { label: 'c', value: 1 },
        ],
      }),
    );
    expect(marks('bar')).toHaveLength(2);
    expect(tableCells().slice(1)).toEqual([
      ['1', 'a', '9'],
      ['2', 'b', '5'],
    ]);
    expect(container.textContent).toContain('+2 more not shown');
  });

  it('ranks an unknown value last with no bar', async () => {
    await render(
      createElement(BarList, {
        label: 'Top sections',
        items: [
          { label: 'unk', value: null },
          { label: 'a', value: 3 },
        ],
      }),
    );
    expect(marks('bar')).toHaveLength(1);
    expect(tableCells().slice(1)).toEqual([
      ['1', 'a', '3'],
      ['2', 'unk', 'unknown'],
    ]);
  });

  // @lat: [[usage-dashboard-charts#Usage Dashboard Charts#Bar lengths scale to the largest value]]
  it('scales bar widths to the largest value', async () => {
    await render(
      createElement(BarList, {
        label: 'Top sections',
        items: [
          { label: 'a', value: 8 },
          { label: 'b', value: 4 },
          { label: 'c', value: 2 },
        ],
      }),
    );
    const widths = [...marks('bar')].map((bar) => num(bar, 'width'));
    expect(widths[1]).toBeCloseTo(widths[0] / 2);
    expect(widths[2]).toBeCloseTo(widths[0] / 4);
  });

  it('draws a negative bar on the other side of the zero line', async () => {
    await render(
      createElement(BarList, {
        label: 'Delta',
        items: [
          { label: 'up', value: 4 },
          { label: 'down', value: -4 },
        ],
      }),
    );
    const [up, down] = [...marks('bar')];
    expect(num(down, 'x') + num(down, 'width')).toBeCloseTo(num(up, 'x'));
  });

  const series = [
    { key: 'bug', label: 'Bug', color: 'var(--agent-claude)' },
    { key: 'task', label: 'Task', color: 'var(--agent-codex)' },
  ];

  // @lat: [[usage-dashboard-charts#Usage Dashboard Charts#Stacked bars stack by series with a legend]]
  it('draws one segment per non-zero value and a legend', async () => {
    await render(
      createElement(StackedBars, {
        label: 'Reads by type',
        series,
        bars: [
          { label: 'Mon', values: { bug: 2, task: 3 } },
          { label: 'Tue', values: { bug: 0, task: 5 } },
        ],
      }),
    );
    expect(marks('segment')).toHaveLength(3);
    const legend = [...container.querySelectorAll('li')].map(
      (item) => item.textContent,
    );
    expect(legend).toEqual(['Bug', 'Task']);
    expect(tableCells().slice(1)).toEqual([
      ['Mon', '2', '3'],
      ['Tue', '0', '5'],
    ]);
  });

  it('stacks segments so the taller column is the larger total', async () => {
    await render(
      createElement(StackedBars, {
        label: 'Reads by type',
        series,
        bars: [
          { label: 'Mon', values: { bug: 2, task: 2 } },
          { label: 'Tue', values: { bug: 4, task: 4 } },
        ],
      }),
    );
    const heights = [...marks('segment')].map((s) => num(s, 'height'));
    expect(heights[0]).toBeCloseTo(heights[1]);
    expect(heights[2]).toBeCloseTo(heights[0] * 2);
  });

  // @lat: [[usage-dashboard-charts#Usage Dashboard Charts#Stacked bars mark unknown segments]]
  it('marks a column with an unknown value and draws no segment for it', async () => {
    await render(
      createElement(StackedBars, {
        label: 'Reads by type',
        series,
        bars: [
          { label: 'Mon', values: { bug: 2, task: null } },
          { label: 'Tue', values: {} },
        ],
      }),
    );
    expect(marks('segment')).toHaveLength(1);
    expect(marks('unknown')).toHaveLength(2);
    expect(tableCells().slice(1)).toEqual([
      ['Mon', '2', 'unknown'],
      ['Tue', 'unknown', 'unknown'],
    ]);
  });

  const range = { low: 100, point: 400, high: 900 };

  // @lat: [[usage-dashboard-charts#Usage Dashboard Charts#Range bar shares one axis]]
  it('draws the range, its point and the cost on one axis', async () => {
    await render(
      createElement(RangeBar, { label: 'Net tokens saved', range, cost: 300 }),
    );
    expect(marks('range')).toHaveLength(1);
    expect(marks('point')).toHaveLength(1);
    expect(marks('cost')).toHaveLength(1);
    expect(marks('zero')).toHaveLength(1);
    const r = marks('range')[0];
    const c = marks('cost')[0];
    const zero = num(marks('zero')[0], 'x1');
    expect(num(c, 'x')).toBeCloseTo(zero);
    // 300 vs a 800-wide range: same scale means width ratio 300/800.
    expect(num(c, 'width') / num(r, 'width')).toBeCloseTo(300 / 800);
    expect(tableText()).toContain('400');
  });

  // @lat: [[usage-dashboard-charts#Usage Dashboard Charts#Range bar guards reversed and negative ranges]]
  it('orders a reversed range', async () => {
    await render(
      createElement(RangeBar, {
        label: 'Net tokens saved',
        range: { low: 900, point: 400, high: 100 },
        cost: 0,
      }),
    );
    const reversed = {
      width: num(marks('range')[0], 'width'),
      x: num(marks('range')[0], 'x'),
    };
    await render(
      createElement(RangeBar, {
        label: 'Net tokens saved',
        range: { low: 100, point: 400, high: 900 },
        cost: 0,
      }),
    );
    const ordered = {
      width: num(marks('range')[0], 'width'),
      x: num(marks('range')[0], 'x'),
    };
    expect(reversed.width).toBeGreaterThan(2);
    expect(reversed.width).toBeCloseTo(ordered.width);
    expect(reversed.x).toBeCloseTo(ordered.x);
  });

  it('draws negative values left of zero', async () => {
    await render(
      createElement(RangeBar, {
        label: 'Net tokens saved',
        range: { low: -500, point: -200, high: -100 },
        cost: -50,
      }),
    );
    const zero = num(marks('zero')[0], 'x1');
    const r = marks('range')[0];
    expect(num(r, 'x') + num(r, 'width')).toBeLessThanOrEqual(zero + 0.001);
    const c = marks('cost')[0];
    expect(num(c, 'x') + num(c, 'width')).toBeCloseTo(zero);
    expect(num(c, 'width')).toBeGreaterThan(0);
  });

  it('reads unknown with its reason for an unknown range', async () => {
    await render(
      createElement(RangeBar, {
        label: 'Net tokens saved',
        range: null,
        rangeReason: 'no baseline',
        cost: 300,
      }),
    );
    expect(marks('range')).toHaveLength(0);
    expect(marks('cost')).toHaveLength(1);
    expect(container.textContent).toContain('unknown (no baseline)');
  });

  const lanes = [
    {
      label: 'Session A',
      events: [
        { id: 'e1', label: 'search', start: 1000, end: 3000 },
        { id: 'e2', label: 'read', start: 4000 },
      ],
    },
    {
      label: 'Session B',
      events: [{ id: 'e3', label: 'search', start: null }],
    },
  ];

  // @lat: [[usage-dashboard-charts#Usage Dashboard Charts#Timeline lanes place events]]
  it('draws known events in lanes and lists unknown ones', async () => {
    await render(
      createElement(TimelineLanes, { label: 'Session trace', lanes }),
    );
    expect(marks('event')).toHaveLength(2);
    expect(container.textContent).toContain('Session A');
    expect(container.textContent).toContain('Session B');
    const rows = tableCells();
    expect(rows).toContainEqual(
      expect.arrayContaining(['Session B', 'e3', 'unknown']),
    );
    expect(container.textContent).toContain('1 event with unknown time');
  });

  it('puts a later event to the right of an earlier one', async () => {
    await render(
      createElement(TimelineLanes, { label: 'Session trace', lanes }),
    );
    const [first, second] = [...marks('event')];
    const left = (el: Element) => num(el, 'x') || num(el, 'cx');
    expect(left(second)).toBeGreaterThan(left(first));
  });

  it('draws a single event', async () => {
    await render(
      createElement(TimelineLanes, {
        label: 'Session trace',
        lanes: [{ label: 'A', events: [{ id: 'x', label: 'q', start: 5 }] }],
      }),
    );
    expect(marks('event')).toHaveLength(1);
    expect(container.innerHTML).not.toMatch(/NaN|Infinity/);
  });

  const visibleText = (element: Element) =>
    [...element.childNodes]
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent)
      .join('');
  const svgTexts = () =>
    [...container.querySelectorAll('svg text')].map((text) => ({
      shown: visibleText(text),
      title: text.querySelector('title')?.textContent,
    }));

  // @lat: [[usage-dashboard-charts#Usage Dashboard Charts#Long text is truncated with the full text kept]]
  it('truncates a long lane label but keeps it in the title and table', async () => {
    const long = 'session-0123456789abcdef0123';
    await render(
      createElement(TimelineLanes, {
        label: 'Trace',
        lanes: [{ label: long, events: [{ id: 'e', label: 'q', start: 1 }] }],
      }),
    );
    const lane = svgTexts().find((text) => text.title === long)!;
    expect(lane.shown).not.toBe(long);
    expect(lane.shown.endsWith('…')).toBe(true);
    expect(tableText()).toContain(long);
  });

  it('truncates a large range caption but keeps every number in the table', async () => {
    await render(
      createElement(RangeBar, {
        label: 'Net tokens saved',
        range: { low: 1200000, point: 2300000, high: 4500000 },
        cost: 3000000,
      }),
    );
    const full = '1,200,000 to 4,500,000, point 2,300,000';
    const caption = svgTexts().find((text) => text.title === full)!;
    expect(caption.shown.length).toBeLessThan(full.length);
    expect(caption.shown.endsWith('…')).toBe(true);
    expect(tableText()).toContain('1,200,000');
    expect(tableText()).toContain('2,300,000');
    expect(tableText()).toContain('4,500,000');
  });

  // @lat: [[usage-dashboard-charts#Usage Dashboard Charts#Timeline events with an unknown end or time stay honest]]
  it('draws an unknown end as an open mark and prints unknown', async () => {
    await render(
      createElement(TimelineLanes, {
        label: 'Trace',
        lanes: [
          {
            label: 'A',
            events: [
              { id: 'open', label: 'x', start: 1000, end: null },
              { id: 'span', label: 'y', start: 1000, end: 5000 },
              { id: 'instant', label: 'z', start: 3000 },
            ],
          },
        ],
      }),
    );
    expect(marks('event')).toHaveLength(3);
    expect(container.querySelectorAll('[data-end="unknown"]')).toHaveLength(1);
    expect(
      container.querySelectorAll('circle[data-mark="event"]'),
    ).toHaveLength(1);
    const rows = tableCells();
    expect(rows).toContainEqual([
      'A',
      'open',
      'x',
      '1970-01-01T00:00:01Z',
      'unknown',
    ]);
    expect(rows).toContainEqual([
      'A',
      'instant',
      'z',
      '1970-01-01T00:00:03Z',
      '1970-01-01T00:00:03Z',
    ]);
  });

  it('renders an invalid time as unknown instead of throwing', async () => {
    await render(
      createElement(TimelineLanes, {
        label: 'Trace',
        lanes: [
          {
            label: 'A',
            events: [
              { id: 'nan', label: 'x', start: NaN },
              { id: 'big', label: 'y', start: 1e20 },
              { id: 'ok', label: 'z', start: 1000, end: NaN },
            ],
          },
        ],
      }),
    );
    expect(marks('event')).toHaveLength(1);
    const rows = tableCells();
    expect(rows).toContainEqual(['A', 'nan', 'x', 'unknown', 'unknown']);
    expect(rows).toContainEqual(['A', 'big', 'y', 'unknown', 'unknown']);
    expect(container.innerHTML).not.toMatch(/NaN|Infinity/);
  });

  // @lat: [[usage-dashboard-charts#Usage Dashboard Charts#Empty data shows a no-data state]]
  it.each([
    ['Sparkline', createElement(Sparkline, { label: 'L', points: [] })],
    ['BarList', createElement(BarList, { label: 'L', items: [] })],
    [
      'StackedBars',
      createElement(StackedBars, { label: 'L', series, bars: [] }),
    ],
    [
      'RangeBar',
      createElement(RangeBar, { label: 'L', range: null, cost: null }),
    ],
    ['TimelineLanes', createElement(TimelineLanes, { label: 'L', lanes: [] })],
  ])('%s shows a no-data state instead of an empty svg', async (_n, el) => {
    await render(el);
    expect(container.textContent).toContain('no data');
    expect(container.querySelector('svg')).toBeNull();
  });

  it('keeps the reason in the RangeBar no-data state', async () => {
    await render(
      createElement(RangeBar, {
        label: 'L',
        range: null,
        rangeReason: 'no baseline',
        cost: null,
      }),
    );
    expect(container.textContent).toContain('unknown (no baseline)');
  });

  // @lat: [[usage-dashboard-charts#Usage Dashboard Charts#Every chart exposes its numbers as text]]
  it.each([
    [
      'BarList',
      createElement(BarList, { label: 'N', items: [{ label: 'a', value: 1 }] }),
    ],
    [
      'StackedBars',
      createElement(StackedBars, {
        label: 'N',
        series,
        bars: [{ label: 'Mon', values: { bug: 1 } }],
      }),
    ],
    ['RangeBar', createElement(RangeBar, { label: 'N', range, cost: 3 })],
    ['TimelineLanes', createElement(TimelineLanes, { label: 'N', lanes })],
  ])('%s has an accessible name and a hidden table', async (_n, el) => {
    await render(el);
    expect(
      container.querySelector('[role="group"][aria-label="N"]'),
    ).not.toBeNull();
    expect(container.querySelector('svg')!.getAttribute('aria-hidden')).toBe(
      'true',
    );
    expect(container.querySelector('table caption')!.textContent).toBe('N');
  });

  // @lat: [[usage-dashboard-charts#Usage Dashboard Charts#The hidden table cannot widen the page]]
  it('wraps the hidden table in a visually hidden div', async () => {
    await render(
      createElement(BarList, { label: 'N', items: [{ label: 'a', value: 1 }] }),
    );
    const table = container.querySelector('table')!;
    const wrapper = table.parentElement!;
    expect(wrapper.tagName).toBe('DIV');
    expect(wrapper.getAttribute('role')).toBeNull();
    expect(wrapper.style).toMatchObject({
      position: 'absolute',
      width: '1px',
      height: '1px',
      overflow: 'hidden',
      whiteSpace: 'nowrap',
      margin: '-1px',
    });
    expect(wrapper.style.clip).toMatch(/^rect\(0/);
    expect(table.getAttribute('style')).toBeNull();
    expect(table.querySelector('caption')!.textContent).toBe('N');
  });
});
