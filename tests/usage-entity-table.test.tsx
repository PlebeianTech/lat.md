// @vitest-environment jsdom
/// <reference types="vite/client" />
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EntityTable, type EntityColumn } from '../view/src/usage/entity-table';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

interface Row {
  id: string;
  name: string;
  reads: number | null;
  children?: Row[];
  days?: { day: string; value: number | null }[];
}

const COLUMNS: EntityColumn<Row>[] = [
  { key: 'name', header: 'Name', value: (row) => row.name },
  {
    key: 'reads',
    header: 'Reads',
    numeric: true,
    value: (row) => row.reads,
    format: (value) => `${value} reads`,
  },
];

const row = (id: string, reads: number | null, extra: Partial<Row> = {}) => ({
  id,
  name: `name-${id}`,
  reads,
  ...extra,
});

describe('usage dashboard entity table', () => {
  let root: Root;
  let container: HTMLDivElement;

  async function render(
    rows: Row[],
    props: Partial<Parameters<typeof EntityTable<Row>>[0]> = {},
  ): Promise<void> {
    await act(async () =>
      root.render(
        createElement(EntityTable<Row>, {
          label: 'Things',
          columns: COLUMNS,
          rows,
          rowKey: (r) => r.id,
          href: (r) => `/_usage/things/${r.id}`,
          childRows: (r) => r.children ?? [],
          trend: undefined,
          ...props,
        }) as ReactElement,
      ),
    );
  }
  const table = () =>
    container.querySelector('table[data-entity-table]') as HTMLTableElement;
  const bodyRows = () => [...table().tBodies[0].rows];
  const names = () =>
    bodyRows().map((r) => r.querySelector('td a')!.textContent!);
  const header = (name: string) =>
    [...table().tHead!.rows[0].cells].find((th) =>
      th.textContent!.includes(name),
    ) as HTMLTableCellElement;
  const click = (element: Element) =>
    act(async () => (element as HTMLElement).click());
  const buttonByText = (text: string) =>
    [...container.querySelectorAll('button')].find((b) =>
      b.textContent!.includes(text),
    ) as HTMLButtonElement;
  async function type(value: string): Promise<void> {
    const input = container.querySelector(
      'input[type="search"]',
    ) as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!.set!.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  // @lat: [[usage-dashboard-entity-table#Usage Dashboard Entity Table#Sorting orders rows both ways]]
  it('sorts ascending then descending by numeric value', async () => {
    await render([row('a', 10), row('b', 9), row('c', 100)]);
    const button = header('Reads').querySelector('button')!;
    expect(header('Reads').getAttribute('aria-sort')).toBe('none');
    await click(button);
    expect(names()).toEqual(['name-b', 'name-a', 'name-c']);
    expect(header('Reads').getAttribute('aria-sort')).toBe('ascending');
    await click(button);
    expect(names()).toEqual(['name-c', 'name-a', 'name-b']);
    expect(header('Reads').getAttribute('aria-sort')).toBe('descending');
  });

  // @lat: [[usage-dashboard-entity-table#Usage Dashboard Entity Table#Unknown values sort last in both directions]]
  it('puts unknown values last in both directions', async () => {
    await render([row('a', null), row('b', 5), row('c', 0), row('d', null)]);
    const button = header('Reads').querySelector('button')!;
    await click(button);
    expect(names()).toEqual(['name-c', 'name-b', 'name-a', 'name-d']);
    await click(button);
    expect(names()).toEqual(['name-b', 'name-c', 'name-a', 'name-d']);
  });

  // @lat: [[usage-dashboard-entity-table#Usage Dashboard Entity Table#Ties break by row key]]
  it('breaks ties by row key in both directions', async () => {
    await render([row('c', 1), row('a', 1), row('b', 1)]);
    const button = header('Reads').querySelector('button')!;
    await click(button);
    expect(names()).toEqual(['name-a', 'name-b', 'name-c']);
    await click(button);
    expect(names()).toEqual(['name-a', 'name-b', 'name-c']);
  });

  // @lat: [[usage-dashboard-entity-table#Usage Dashboard Entity Table#Unknown cells read unknown]]
  it('renders null as unknown, never zero or blank', async () => {
    await render([row('a', null), row('b', 0)]);
    const cells = bodyRows().map(
      (r) => r.querySelectorAll('td')[1].textContent,
    );
    expect(cells).toEqual(['unknown', '0 reads']);
    await render([row('a', null)], {
      columns: [
        COLUMNS[0],
        { ...COLUMNS[1], unknownText: 'unknown (no transcript)' },
      ],
    });
    expect(bodyRows()[0].querySelectorAll('td')[1].textContent).toBe(
      'unknown (no transcript)',
    );
  });

  // @lat: [[usage-dashboard-entity-table#Usage Dashboard Entity Table#Only the top 25 rows show until asked]]
  it('shows 25 rows and a control to show all', async () => {
    const rows = Array.from({ length: 30 }, (_, i) =>
      row(String(i).padStart(2, '0'), i),
    );
    await render(rows);
    expect(bodyRows()).toHaveLength(25);
    await click(buttonByText('Show all 30'));
    expect(bodyRows()).toHaveLength(30);
    await click(buttonByText('Show top 25'));
    expect(bodyRows()).toHaveLength(25);
  });

  it('offers no show-all control for 25 rows or fewer', async () => {
    await render(Array.from({ length: 25 }, (_, i) => row(String(i), i)));
    expect(buttonByText('Show all')).toBeUndefined();
  });

  // @lat: [[usage-dashboard-entity-table#Usage Dashboard Entity Table#Name filter narrows the rows]]
  it('filters by the name column ignoring case', async () => {
    await render([row('alpha', 1), row('beta', 2), row('ALPHABET', 3)]);
    await type('Alpha');
    expect(names()).toEqual(['name-alpha', 'name-ALPHABET']);
  });

  it('keeps the parents of a matching nested row', async () => {
    await render([
      row('p', 1, { children: [row('hit', 2)] }),
      row('q', 3, { children: [row('miss', 4)] }),
    ]);
    await type('hit');
    expect(names()).toEqual(['name-p', 'name-hit']);
  });

  // @lat: [[usage-dashboard-entity-table#Usage Dashboard Entity Table#Nested rows expand and collapse]]
  it('expands and collapses nested rows', async () => {
    await render([row('p', 1, { children: [row('kid', 2)] }), row('solo', 3)]);
    expect(names()).toEqual(['name-p', 'name-solo']);
    const toggle = bodyRows()[0].querySelector('button[aria-expanded]')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(bodyRows()[1].querySelector('button[aria-expanded]')).toBeNull();
    await click(toggle);
    expect(names()).toEqual(['name-p', 'name-kid', 'name-solo']);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    await click(toggle);
    expect(names()).toEqual(['name-p', 'name-solo']);
  });

  // @lat: [[usage-dashboard-entity-table#Usage Dashboard Entity Table#Rows link to their detail path]]
  it('links each row name to its detail path', async () => {
    await render([row('a', 1), row('b', 2)]);
    const links = bodyRows().map((r) =>
      r.querySelector('a')!.getAttribute('href'),
    );
    expect(links).toEqual(['/_usage/things/a', '/_usage/things/b']);
  });

  // @lat: [[usage-dashboard-entity-table#Usage Dashboard Entity Table#Sparkline column draws a trend per row]]
  it('draws a sparkline per row when a trend is given', async () => {
    await render(
      [
        row('a', 1, {
          days: [
            { day: '2026-01-01', value: 1 },
            { day: '2026-01-02', value: 4 },
          ],
        }),
        row('b', 2, { days: [] }),
      ],
      { trend: { header: 'Trend', points: (r) => r.days ?? [] } },
    );
    expect(header('Trend')).toBeDefined();
    expect(bodyRows()[0].querySelectorAll('[data-mark="line"]')).toHaveLength(
      1,
    );
    expect(bodyRows()[1].querySelectorAll('[data-mark="line"]')).toHaveLength(
      0,
    );
  });

  it('keeps the keyboard focus outline on sort and expand buttons', async () => {
    await render([row('p', 1, { children: [row('kid', 2)] })]);
    const buttons = [...table().querySelectorAll('button')];
    expect(buttons).toHaveLength(3);
    for (const button of buttons) {
      expect(button.style.outline).toBe('');
      expect(button.style.getPropertyValue('all')).toBe('');
    }
  });

  it('opens only parents with a matching descendant while filtering', async () => {
    await render([
      row('p', 1, { children: [row('hit', 2)] }),
      row('hit-parent', 3, { children: [row('other', 4)] }),
    ]);
    await type('hit');
    // p opens (descendant matches) and its toggle is disabled.
    const forced = bodyRows()[0].querySelector(
      'button[aria-expanded]',
    ) as HTMLButtonElement;
    expect(forced.disabled).toBe(true);
    expect(forced.getAttribute('aria-expanded')).toBe('true');
    await click(forced);
    expect(names()).toContain('name-hit');
    // A parent matching only by its own name keeps its stored (collapsed) state.
    const own = bodyRows().find(
      (r) => r.querySelector('td a')!.textContent === 'name-hit-parent',
    )!;
    const toggle = own.querySelector(
      'button[aria-expanded]',
    ) as HTMLButtonElement;
    expect(toggle.disabled).toBe(false);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(names()).not.toContain('name-other');
    await click(toggle);
    expect(names()).toContain('name-other');
    await type('');
    expect(names()).toEqual(['name-p', 'name-hit-parent', 'name-other']);
  });

  it('keeps a stable order when rows change under a fixed sort', async () => {
    await render([row('a', 3), row('b', 1), row('c', null)]);
    await click(header('Reads').querySelector('button')!);
    expect(names()).toEqual(['name-b', 'name-a', 'name-c']);
    await render([
      row('a', 1),
      row('b', 1),
      row('c', 0),
      row('d', null),
      row('e', null),
    ]);
    expect(names()).toEqual(['name-c', 'name-a', 'name-b', 'name-d', 'name-e']);
  });

  it('keeps expanded state when rows are re-rendered', async () => {
    const make = (reads: number) => [
      row('p', reads, { children: [row('kid', 2)] }),
    ];
    await render(make(1));
    await click(bodyRows()[0].querySelector('button[aria-expanded]')!);
    await render(make(5));
    expect(names()).toEqual(['name-p', 'name-kid']);
  });

  it('applies defaultSort and lets the user change it', async () => {
    await render([row('a', 1), row('b', 3), row('c', 2)], {
      defaultSort: { key: 'reads', direction: 'descending' },
    });
    expect(names()).toEqual(['name-b', 'name-c', 'name-a']);
    expect(header('Reads').getAttribute('aria-sort')).toBe('descending');
    await click(header('Reads').querySelector('button')!);
    expect(names()).toEqual(['name-a', 'name-c', 'name-b']);
  });

  it('sorts child rows with unknown values last', async () => {
    await render([
      row('p', 1, { children: [row('x', null), row('y', 5), row('z', 2)] }),
    ]);
    await click(bodyRows()[0].querySelector('button[aria-expanded]')!);
    const button = header('Reads').querySelector('button')!;
    await click(button);
    expect(names()).toEqual(['name-p', 'name-z', 'name-y', 'name-x']);
    await click(button);
    expect(names()).toEqual(['name-p', 'name-y', 'name-z', 'name-x']);
  });

  // @lat: [[usage-dashboard-entity-table#Usage Dashboard Entity Table#Empty state names the active filters]]
  it('names the active filters when nothing matches', async () => {
    await render([], { activeFilters: ['agent: claude', 'from: 2026-01-01'] });
    const text = container.textContent!;
    expect(text).toContain('No rows match');
    expect(text).toContain('agent: claude');
    expect(text).toContain('from: 2026-01-01');
    expect(
      container.querySelector('table[data-entity-table] tbody tr'),
    ).toBeNull();
  });

  it('says there are no rows when no filter is active', async () => {
    await render([]);
    expect(container.textContent).toContain('No rows.');
    expect(container.textContent).not.toContain('match');
  });

  it('names the text filter in the empty state', async () => {
    await render([row('a', 1)]);
    await type('zzz');
    expect(container.textContent).toContain('No rows match');
    expect(container.textContent).toContain('zzz');
  });

  // @lat: [[usage-dashboard-entity-table#Usage Dashboard Entity Table#Table scrolls inside its own container]]
  it('wraps the table in a focusable scroll container and adds no footer', async () => {
    await render([row('a', 1), row('b', 2)]);
    const scroller = table().parentElement!;
    expect(scroller.getAttribute('tabindex')).toBe('0');
    expect(scroller.style.overflowX).toBe('auto');
    expect(table().querySelector('tfoot')).toBeNull();
  });
});
