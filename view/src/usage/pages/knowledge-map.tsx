import type { ReactElement } from 'react';
import { ChartFrame, EmptyChart, formatValue } from '../charts/chart-parts';

export interface MapDocument {
  path: string;
  bytes: number;
  reads: number;
}

interface Block extends MapDocument {
  x: number;
  y: number;
  width: number;
  height: number;
}

const WIDTH = 400;
const HEIGHT = 240;
const RAMP_STEPS = 5;

/** Splits the list where the two halves hold about equal bytes, then recurses on the longer side. */
function layout(
  documents: MapDocument[],
  x: number,
  y: number,
  width: number,
  height: number,
): Block[] {
  if (documents.length === 0) return [];
  if (documents.length === 1) return [{ ...documents[0], x, y, width, height }];
  const total = documents.reduce((sum, d) => sum + d.bytes, 0);
  let split = 1;
  let first = documents[0].bytes;
  while (split < documents.length - 1 && first < total / 2) {
    first += documents[split].bytes;
    split += 1;
  }
  const share = total === 0 ? split / documents.length : first / total;
  const head = documents.slice(0, split);
  const tail = documents.slice(split);
  return width >= height
    ? [
        ...layout(head, x, y, width * share, height),
        ...layout(tail, x + width * share, y, width * (1 - share), height),
      ]
    : [
        ...layout(head, x, y, width, height * share),
        ...layout(tail, x, y + height * share, width, height * (1 - share)),
      ];
}

/** Step 1 (palest) for no reads, up to the top step for the most-read document. */
function rampStep(reads: number, mostReads: number): number {
  if (reads <= 0 || mostReads <= 0) return 1;
  return Math.min(
    RAMP_STEPS,
    1 + Math.ceil(((RAMP_STEPS - 1) * reads) / mostReads),
  );
}

/** One block per document: area by bytes, shade by reads, so large pale blocks stand out. */
export function KnowledgeMap({
  documents,
}: {
  documents: MapDocument[];
}): ReactElement {
  const label = 'Knowledge map';
  if (documents.length === 0) return <EmptyChart label={label} />;
  const ordered = [...documents].sort(
    (a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path),
  );
  const mostReads = Math.max(...ordered.map((d) => d.reads));
  const blocks = layout(ordered, 0, 0, WIDTH, HEIGHT);
  return (
    <ChartFrame
      label={label}
      head={['Document', 'Bytes', 'Reads']}
      rows={ordered.map((d) => [
        d.path,
        formatValue(d.bytes),
        formatValue(d.reads),
      ])}
    >
      <svg
        aria-hidden="true"
        focusable="false"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        style={{ display: 'block', width: '100%', height: 'auto' }}
      >
        {blocks.map((block) => (
          <rect
            key={block.path}
            data-document={block.path}
            data-bytes={block.bytes}
            data-reads={block.reads}
            x={block.x}
            y={block.y}
            width={block.width}
            height={block.height}
            style={{
              fill: `var(--heat-${rampStep(block.reads, mostReads)})`,
              stroke: 'var(--background)',
              strokeWidth: 1,
            }}
          >
            <title>
              {`${block.path}: ${formatValue(block.bytes)} bytes, ${formatValue(block.reads)} reads`}
            </title>
          </rect>
        ))}
      </svg>
      <p
        style={{
          color: 'var(--muted)',
          margin: 0,
          fontSize: 12,
        }}
      >
        Block area is bytes; darker is more reads. Large pale blocks cost upkeep
        and are rarely read.
      </p>
    </ChartFrame>
  );
}
