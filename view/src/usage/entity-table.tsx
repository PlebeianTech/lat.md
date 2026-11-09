import { useState, type MouseEvent, type ReactElement } from 'react';
import { Sparkline, type SparklinePoint } from './charts/sparkline';
import { shorten } from './charts/chart-parts';
import { navigateTo } from './filters';

export interface EntityColumn<Row> {
  key: string;
  header: string;
  /** The value to show and sort by. `null` is unknown. */
  value: (row: Row) => number | string | null;
  /** Formats a known value. Defaults to `toLocaleString` for numbers. */
  format?: (value: number | string) => string;
  /** What a `null` value reads as. Defaults to "unknown". */
  unknownText?: string;
  /** Right-aligns the column with tabular figures. */
  numeric?: boolean;
}

export interface EntityTableProps<Row> {
  /** Accessible name of the table. */
  label: string;
  /** The first column is the name column: it holds the row link and the text filter. */
  columns: EntityColumn<Row>[];
  rows: Row[];
  rowKey: (row: Row) => string;
  href: (row: Row) => string;
  /** Child rows for tree data. Omit for a flat table. */
  childRows?: (row: Row) => Row[];
  /** An optional sparkline column. It is not sortable. */
  trend?: { header: string; points: (row: Row) => SparklinePoint[] };
  /** Active page filters, such as "agent: claude", named in the empty state. */
  activeFilters?: string[];
  /** Initial sort. Without it rows keep the order given. */
  defaultSort?: { key: string; direction: 'ascending' | 'descending' };
}

// No footer or totals row exists on purpose: issue rows share events, so summing them double counts.

const TOP_ROWS = 25;
const NAME_LENGTH = 60;
// Keeps the browser focus outline, which `all: unset` would remove.
const BUTTON_RESET = {
  background: 'none',
  border: 0,
  font: 'inherit',
  color: 'inherit',
  padding: 0,
  cursor: 'pointer',
} as const;
const NO_CHILDREN = () => [];

type Direction = 'ascending' | 'descending';

function compareKnown(a: number | string, b: number | string): number {
  return typeof a === 'number' && typeof b === 'number'
    ? a - b
    : String(a).localeCompare(String(b));
}

function cellText<Row>(column: EntityColumn<Row>, row: Row): string {
  const value = column.value(row);
  if (value === null) return column.unknownText ?? 'unknown';
  if (column.format) return column.format(value);
  return typeof value === 'number' ? value.toLocaleString('en-US') : value;
}

function sortRows<Row>(
  rows: Row[],
  column: EntityColumn<Row> | undefined,
  direction: Direction,
  rowKey: (row: Row) => string,
): Row[] {
  if (!column) return rows;
  const sign = direction === 'ascending' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const left = column.value(a);
    const right = column.value(b);
    if (left === null && right !== null) return 1;
    if (right === null && left !== null) return -1;
    const order =
      left === null || right === null ? 0 : sign * compareKnown(left, right);
    return order || rowKey(a).localeCompare(rowKey(b));
  });
}

interface Shown<Row> {
  row: Row;
  depth: number;
  children: Row[];
  open: boolean;
  forced: boolean;
}

/** A sortable, filterable table for entity pages. */
export function EntityTable<Row>({
  label,
  columns,
  rows,
  rowKey,
  href,
  childRows = NO_CHILDREN,
  trend,
  activeFilters = [],
  defaultSort,
}: EntityTableProps<Row>): ReactElement {
  const [sort, setSort] = useState<
    { key: string; direction: Direction } | undefined
  >(defaultSort);
  const [showAll, setShowAll] = useState(false);
  const [text, setText] = useState('');
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  const nameColumn = columns[0];
  const sortColumn = columns.find((column) => column.key === sort?.key);
  const needle = text.trim().toLowerCase();

  const direction = sort?.direction ?? 'ascending';
  const matches = (row: Row): boolean =>
    !needle ||
    cellText(nameColumn, row).toLowerCase().includes(needle) ||
    childRows(row).some(matches);
  const sortWith = (list: Row[]): Row[] =>
    sortRows(list, sortColumn, direction, rowKey);

  const topRows = sortWith(rows.filter(matches));
  const visibleTop = showAll ? topRows : topRows.slice(0, TOP_ROWS);
  const shown: Shown<Row>[] = [];
  const walk = (row: Row, depth: number): void => {
    const children = childRows(row);
    // Only a parent with a matching descendant is forced open; the toggle is disabled then.
    const forced = Boolean(needle) && children.some(matches);
    const open = children.length > 0 && (forced || expanded.has(rowKey(row)));
    shown.push({ row, depth, children, open, forced });
    if (open)
      sortWith(forced ? children.filter(matches) : children).forEach((child) =>
        walk(child, depth + 1),
      );
  };
  visibleTop.forEach((row) => walk(row, 0));

  function toggleSort(key: string): void {
    setSort((current) => ({
      key,
      direction:
        current?.key === key && current.direction === 'ascending'
          ? 'descending'
          : 'ascending',
    }));
  }
  function toggleExpanded(key: string): void {
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }
  function follow(event: MouseEvent<HTMLAnchorElement>, url: string): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0)
      return;
    event.preventDefault();
    navigateTo(url);
  }

  const emptyFilters = [
    ...activeFilters,
    ...(needle ? [`name: ${text.trim()}`] : []),
  ];

  return (
    <div>
      <input
        type="search"
        aria-label={`Filter ${label} by ${nameColumn.header.toLowerCase()}`}
        placeholder={`Filter by ${nameColumn.header.toLowerCase()}`}
        value={text}
        onChange={(event) => setText(event.target.value)}
        style={{
          maxWidth: '100%',
          marginBottom: '0.5rem',
          padding: '0.25rem 0.5rem',
          border: '1px solid var(--panel-border)',
          borderRadius: 6,
          background: 'var(--panel)',
          color: 'var(--text)',
          font: 'inherit',
        }}
      />
      <div
        role="region"
        aria-label={label}
        tabIndex={0}
        style={{ overflowX: 'auto', maxWidth: '100%' }}
      >
        <table
          data-entity-table=""
          style={{ borderCollapse: 'collapse', width: '100%' }}
        >
          <thead>
            <tr>
              {columns.map((column) => (
                <th
                  key={column.key}
                  scope="col"
                  aria-sort={sort?.key === column.key ? sort.direction : 'none'}
                  style={{
                    padding: '0.375rem 0.5rem',
                    borderBottom: '1px solid var(--panel-border)',
                    textAlign: column.numeric ? 'right' : 'left',
                    whiteSpace: 'nowrap',
                  }}
                >
                  <button
                    type="button"
                    onClick={() => toggleSort(column.key)}
                    style={BUTTON_RESET}
                  >
                    {column.header}
                    {sort?.key === column.key &&
                      (sort.direction === 'ascending' ? ' ▲' : ' ▼')}
                  </button>
                </th>
              ))}
              {trend && (
                <th
                  scope="col"
                  style={{ padding: '0.375rem 0.5rem', textAlign: 'left' }}
                >
                  {trend.header}
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {shown.map(({ row, depth, children, open, forced }) => {
              const key = rowKey(row);
              const name = cellText(nameColumn, row);
              const url = href(row);
              return (
                <tr
                  key={`${depth}:${key}`}
                  style={{ borderBottom: '1px solid var(--panel-border)' }}
                >
                  {columns.map((column, index) => (
                    <td
                      key={column.key}
                      style={{
                        padding: '0.375rem 0.5rem',
                        textAlign: column.numeric ? 'right' : 'left',
                        fontVariantNumeric: column.numeric
                          ? 'tabular-nums'
                          : undefined,
                        paddingLeft:
                          index === 0 ? `${0.5 + depth * 1.25}rem` : undefined,
                      }}
                    >
                      {index === 0 ? (
                        <>
                          {children.length > 0 && (
                            <button
                              type="button"
                              aria-expanded={open}
                              disabled={forced}
                              aria-label={`${open ? 'Collapse' : 'Expand'} ${name}`}
                              onClick={() => toggleExpanded(key)}
                              style={{
                                ...BUTTON_RESET,
                                marginRight: '0.375rem',
                              }}
                            >
                              {open ? '▾' : '▸'}
                            </button>
                          )}
                          <a
                            href={url}
                            title={name}
                            onClick={(event) => follow(event, url)}
                          >
                            {shorten(name, NAME_LENGTH)}
                          </a>
                        </>
                      ) : (
                        cellText(column, row)
                      )}
                    </td>
                  ))}
                  {trend && (
                    <td style={{ padding: '0.375rem 0.5rem' }}>
                      <Sparkline
                        label={`${name} ${trend.header}`}
                        points={trend.points(row)}
                      />
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {topRows.length === 0 && (
        <p>
          {emptyFilters.length > 0
            ? `No rows match the active filters: ${emptyFilters.join(', ')}.`
            : 'No rows.'}
        </p>
      )}
      {topRows.length > TOP_ROWS && (
        <button type="button" onClick={() => setShowAll((current) => !current)}>
          {showAll ? `Show top ${TOP_ROWS}` : `Show all ${topRows.length}`}
        </button>
      )}
    </div>
  );
}
