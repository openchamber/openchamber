import React from 'react';
import type { ComponentRenderProps } from '@openuidev/react-lang';
import type { OpenUIProps } from './openuiProps';
import { gridProps, gridItemProps } from './openuiCatalog.schema';
import { OpenUIOccurrence } from './openuiHost';

const ColumnsContext = React.createContext(1);
const gridOptions = gridProps.pick({ options: true });
const columnSpan = gridItemProps.pick({ colSpan: true });
const rowSpan = gridItemProps.pick({ rowSpan: true });

export function ChamberGrid({ props, renderNode }: ComponentRenderProps<OpenUIProps['Grid']>) {
  // The streaming parser does not enforce JSON-schema numeric bounds. Keep
  // geometry bounded at the adapter too, including locally edited options.
  const options = gridOptions.safeParse({ options: props.options }).data?.options;
  const requested = options?.columns ?? 2;
  const weights = Array.isArray(requested) ? requested : Array.from({ length: requested }, () => 1);
  const count = weights.length;
  const weightRatio = weights.reduce((sum, value) => sum + value, 0) / Math.min(...weights);
  const minimum = options?.minChildWidth ?? 12;
  const gap = options?.gap === 'none' ? '0px' : `var(--openui-space-${options?.gap ?? 'm'})`;
  const ref = React.useRef<HTMLDivElement>(null);
  const [columns, setColumns] = React.useState(1);
  React.useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => {
      const style = getComputedStyle(element);
      const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      const gutter = Number.parseFloat(style.columnGap) || 0;
      const available = element.clientWidth;
      const fitting = Math.max(1, Math.floor((available + gutter) / (minimum * rem + gutter)));
      const weightedMinimum = minimum * rem * weightRatio;
      const fitsWeights = available >= weightedMinimum + gutter * (count - 1);
      setColumns(fitsWeights ? count : Math.min(Math.max(1, count - 1), fitting));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [count, minimum, gap, weightRatio]);
  const actual = Math.min(columns, count);
  const tracks = actual === count
    ? weights.map((weight) => `minmax(0, ${weight}fr)`).join(' ')
    : `repeat(${actual}, minmax(0, 1fr))`;
  return (
    <ColumnsContext.Provider value={actual}>
      <div ref={ref} className="openui-grid" style={{ display: 'grid', gridTemplateColumns: tracks, gap }}>
        {(props.children ?? []).map((child, index) => (
          <OpenUIOccurrence key={index} occurrence={`children/${index}`}>
            {renderNode(child)}
          </OpenUIOccurrence>
        ))}
      </div>
    </ColumnsContext.Provider>
  );
}

export function ChamberGridItem({ props, renderNode }: ComponentRenderProps<OpenUIProps['GridItem']>) {
  const columns = React.useContext(ColumnsContext);
  const column = columnSpan.safeParse({ colSpan: props.colSpan });
  const row = rowSpan.safeParse({ rowSpan: props.rowSpan });
  const columnCount = Math.min(columns, column.data?.colSpan ?? 1);
  const rowCount = columns === 1 ? 1 : row.data?.rowSpan ?? 1;
  return (
    <div className="openui-grid-item" style={{ gridColumn: `span ${columnCount}`, gridRow: `span ${rowCount}` }}>
      {(props.children ?? []).map((child, index) => (
        <OpenUIOccurrence key={index} occurrence={`children/${index}`}>
          {renderNode(child)}
        </OpenUIOccurrence>
      ))}
    </div>
  );
}
