---
lat:
  require-code-mention: true
---

# Usage Dashboard Charts

Tests in `tests/usage-charts.test.tsx` for the hand-written SVG chart components in `view/src/usage/charts/`: `Sparkline`, `BarList`, `StackedBars`, `RangeBar` and `TimelineLanes`.

They render each component in jsdom and assert on marks, values and structure, never on pixel positions, except where a section says a mark scales to its bounds. None asserts on elapsed time.

## Sparkline draws one line per run of known days

A series of known values draws a single line, and its extreme values land inside the drawing box, the largest at the top and the smallest at the bottom. A flat series draws a finite line.

## Sparkline leaves unknown days as gaps

A `null` value splits the line in two and draws nothing at that day. It is never drawn as zero. A run of one known day is drawn as a dot. The `aria-label` counts the unknown days.

## Sparkline with one point draws a dot

A series with a single known value draws one dot and no line.

## Bar list ranks and limits

`BarList` ranks items by value, largest first, keeps the top `limit`, and says how many were left out. An unknown value ranks last, draws no bar and reads "unknown".

## Bar lengths scale to the largest value

The longest bar belongs to the largest value and every other bar is in proportion to it. A negative value draws its bar on the other side of the zero line.

## Stacked bars stack by series with a legend

`StackedBars` draws one column per category and one segment per known non-zero value, and lists every series in a legend.

## Stacked bars mark unknown segments

A column with an unknown value gets an unknown mark and no segment for it. The text equivalent says "unknown".

## Range bar shares one axis

`RangeBar` draws the low to high range with a point mark, and a cost bar, on one axis that includes zero.

## Range bar guards reversed and negative ranges

A range given with low above high is drawn between the lower and the higher value. A negative range and a negative cost are drawn on the left of the zero line. An unknown range reads "unknown" with its reason and draws no bar.

## Timeline lanes place events

`TimelineLanes` draws one mark for each event with a known start, in its lane, and lists every lane label. An event with no end is an instant. An event with an unknown start is listed but not drawn.

## Timeline events with an unknown end or time stay honest

Only an absent `end` makes an instant. A `null` or invalid `end` draws a dashed open-ended mark and reads "unknown" in the End column. A start that is not a valid time reads "unknown" and is not drawn, and never throws.

## Long text is truncated with the full text kept

A lane label or a range caption too long for its column is cut with an ellipsis in the drawing, while an SVG title and the hidden table keep the full text.

## Empty data shows a no-data state

Each chart given no data renders a visible "no data" message and no SVG.

## Every chart exposes its numbers as text

Each chart except `Sparkline` carries an accessible name and a visually hidden table holding the values it draws, with `unknown` for a missing value.

`Sparkline` sits inside table cells, so it has `role="img"` and one `aria-label` giving the day count, minimum, maximum, last value and the number of unknown days, and no nested table.

## The hidden table cannot widen the page

The value table sits inside a `div` that carries the visually hidden style: absolute position, 1px square, -1px margin, hidden overflow, `clip: rect(0 0 0 0)` and no wrapping.

The table itself has no style, so its caption and cells stay readable by assistive tech.

A table box ignores `width` and `overflow`, so styling the table directly left it at its full width and made Agents and Utilization scroll sideways at 375px. The wrapper clips it instead.
