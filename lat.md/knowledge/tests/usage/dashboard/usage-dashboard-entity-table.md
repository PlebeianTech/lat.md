---
lat:
  require-code-mention: true
---

# Usage Dashboard Entity Table

Tests in `tests/usage-entity-table.test.tsx` for the sortable entity table in `view/src/usage/entity-table.tsx`, shared by the entity pages of the usage dashboard.

They render `EntityTable` in jsdom and assert on rows, cell text, links and ARIA state. None asserts on elapsed time. The table has no footer or totals row, so per-issue rows are never summed.

## Sorting orders rows both ways

Clicking a sortable column header sorts ascending, and clicking it again sorts descending. Numbers sort by value, not as text. The header carries `aria-sort` and is a button.

## Unknown values sort last in both directions

A row whose sort value is `null` comes after every known row whether the sort is ascending or descending. It is never treated as zero.

## Ties break by row key

Rows with equal sort values keep a fixed order by row key, in both directions.

## Unknown cells read unknown

A `null` cell shows "unknown", or the column's own unknown text. It never shows `0` or a blank.

## Only the top 25 rows show until asked

With more than 25 rows the table shows the first 25 and a control that shows all of them. The control can collapse back to 25.

## Name filter narrows the rows

A text box filters rows by the first column, ignoring case. A nested row that matches keeps its parents.

## Nested rows expand and collapse

A row with children shows an expand button with `aria-expanded`. Children appear under it when expanded and vanish when collapsed.

## Rows link to their detail path

The name cell of each row is a link to the row's detail path.

## Sparkline column draws a trend per row

When a trend is given, each row shows a sparkline in its own column. A row with no days shows an empty chart, not a line.

## Empty state names the active filters

With no rows to show, the table says no rows match and lists the active filters. With no active filters it says there are no rows.

## Table scrolls inside its own container

The table sits in a focusable container that scrolls sideways, so a narrow screen never scrolls the page.
