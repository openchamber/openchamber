import React from 'react';
import { defaultComponents, tableDataToCSV, tableDataToTSV, type ExtraProps } from 'streamdown';
import type { Element } from 'hast';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import { copyTextToClipboard } from '@/lib/clipboard';
import { useUIStore } from '@/stores/useUIStore';
import { useI18n } from '@/lib/i18n';
import { useMarkdownPresentation } from './MarkdownPresentationContext';
import { cn } from '@/lib/utils';

type TableFormat = 'csv' | 'tsv' | 'md';
const copyFormats = ['csv', 'tsv', 'md'] as const;
const downloadFormats = ['csv', 'md'] as const;
const formatLabel = (format: TableFormat) => format === 'md' ? 'Markdown' : format.toUpperCase();
const escapeCell = (text: string) => text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
const TableColumns = React.createContext<ReadonlyMap<Element, boolean>>(new Map());

export function MarkdownTableCell({ node, style, ...props }: React.ComponentProps<'td'> & ExtraProps) {
  const columns = React.useContext(TableColumns);
  const capped = node ? columns.get(node) : undefined;
  const Cell = node?.tagName === 'th' ? defaultComponents.th : defaultComponents.td;
  const cellStyle: React.CSSProperties & { '--oc-table-code-wrap': string } = {
    ...style, '--oc-table-code-wrap': capped ? 'normal' : 'nowrap',
  };
  return <Cell {...props} node={node} style={cellStyle} />;
}

// Keep short columns at their natural width and share only the remaining space.
function fitColumns(natural: number[], available: number, wrap: boolean): number[] {
  const widths = natural.map((width) => Math.min(Math.max(120, available || 320), Math.max(120, width)));
  if (!wrap || available <= 0) return widths;
  let open = widths.map((_, index) => index);
  let remaining = available;
  while (open.length) {
    const share = remaining / open.length;
    const fitting = open.filter((index) => widths[index] <= share);
    if (!fitting.length) {
      for (const index of open) widths[index] = Math.max(120, Math.floor(share));
      break;
    }
    for (const index of fitting) remaining -= widths[index];
    open = open.filter((index) => widths[index] > share);
  }
  return widths;
}

function cellText(node: Node, markdown: boolean): string {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.textContent ?? '';
    return markdown ? escapeCell(text) : text;
  }
  if (node instanceof HTMLAnchorElement) {
    const href = node.getAttribute('href');
    if (href) {
      const url = href.replace(/ /g, '%20');
      if (!markdown) return url;
      const label = escapeCell(node.textContent ?? '').replace(/\[/g, '\\[').replace(/\]/g, '\\]');
      const destination = url.replace(/\|/g, '%7C');
      const wrapped = /[()]/.test(destination)
        ? `<${destination.replace(/</g, '%3C').replace(/>/g, '%3E')}>`
        : destination;
      return `[${label}](${wrapped})`;
    }
  }
  return Array.from(node.childNodes).map((child) => cellText(child, markdown)).join('');
}

function serializeMarkdownTable(table: HTMLTableElement, format: TableFormat): string {
  const rows = Array.from(table.rows).map((row) => Array.from(row.cells).map((cell) => cellText(cell, format === 'md').trim()));
  const data = { headers: rows[0] ?? [], rows: rows.slice(1) };
  if (format === 'csv') return tableDataToCSV(data);
  if (format === 'tsv') return tableDataToTSV(data);
  // Cells already contain escaped Markdown links; do not escape them again.
  return [data.headers, data.headers.map(() => '---'), ...data.rows]
    .map((row) => `| ${row.join(' | ')} |`).join('\n');
}

export function MarkdownTable({ node, className, children, ...props }: React.ComponentProps<'table'> & ExtraProps) {
  const { purpose, settled } = useMarkdownPresentation();
  const wrap = useUIStore((state) => state.tableCellWrap);
  const ref = React.useRef<HTMLTableElement>(null);
  const wrapper = React.useRef<HTMLDivElement>(null);
  const [measurement, setMeasurement] = React.useState<{ node: typeof node; natural: number[]; available: number; font: string } | null>(null);
  const measured = measurement?.node === node ? measurement : null;
  React.useLayoutEffect(() => {
    const table = ref.current;
    const container = wrapper.current?.parentElement;
    // A streaming table grows on every update; measuring it each time forced
    // a layout per update. It keeps its natural layout until the reply settles.
    if (!table || !container || !settled) return;
    const view = table.ownerDocument.defaultView;
    if (!view) return;
    const measure = () => {
      const style = view.getComputedStyle(container);
      const available = Math.max(0, container.clientWidth - (parseFloat(style.paddingInlineStart) || 0) - (parseFloat(style.paddingInlineEnd) || 0) - 2);
      const font = view.getComputedStyle(table).font;
      if (measured && measured.font !== font) {
        setMeasurement(null);
        return;
      }
      if (measured) {
        if (measured.available !== available) setMeasurement({ ...measured, available });
        return;
      }
      if (available <= 0) return;
      const natural: number[] = [];
      const rows = Array.from(table.rows);
      const bodyRows = rows.filter((row) => row.parentElement?.tagName === 'TBODY');
      for (const row of bodyRows.length ? bodyRows : rows) {
        Array.from(row.cells).forEach((cell, index) => {
          natural[index] = Math.max(natural[index] ?? 120, Math.ceil(cell.getBoundingClientRect().width));
        });
      }
      setMeasurement({ node, natural, available, font });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, [node, measured, settled]);
  const widths = React.useMemo(
    () => measured ? fitColumns(measured.natural, measured.available, wrap) : null,
    [measured, wrap],
  );
  const columns = widths?.map((width, index) => (
    <col key={index} style={{ width }} />
  ));
  // A new map re-renders every cell, so it changes only with the table's
  // content or its column widths.
  const cellWrap = React.useMemo(() => {
    const result = new Map<Element, boolean>();
    for (const section of node?.children ?? []) {
      if (section.type !== 'element') continue;
      for (const row of section.children) {
        if (row.type !== 'element' || row.tagName !== 'tr') continue;
        const cells = row.children.filter((cell): cell is Element => cell.type === 'element');
        cells.forEach((cell, index) => result.set(cell, Boolean(widths && measured && measured.natural[index] > widths[index])));
      }
    }
    return result;
  }, [node, widths, measured]);
  const [copied, setCopied] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const { t } = useI18n();
  React.useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const copy = async (format: TableFormat) => {
    if (!ref.current) return;
    const result = await copyTextToClipboard(serializeMarkdownTable(ref.current, format));
    if (!result.ok) return;
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 2000);
  };

  const download = (format: 'csv' | 'md') => {
    const table = ref.current;
    if (!table) return;
    const url = URL.createObjectURL(new Blob([serializeMarkdownTable(table, format)], { type: format === 'csv' ? 'text/csv;charset=utf-8' : 'text/markdown;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `table.${format}`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div ref={wrapper} data-streamdown="table-wrapper" data-table-wrap={wrap ? 'true' : 'false'} className="group flex flex-col">
      {!purpose && (
        <div data-streamdown="table-controls" data-export-ignore className="flex items-center justify-end gap-1">
          <Button
            variant="ghost"
            size="xs"
            title={t(wrap ? 'markdownRenderer.table.actions.disableWrapTitle' : 'markdownRenderer.table.actions.enableWrapTitle')}
            aria-pressed={wrap}
            onClick={() => useUIStore.getState().setTableCellWrap(!wrap)}
          >
            <Icon name="text-wrap" className="size-3.5" />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="xs" title={t(copied ? 'markdownRenderer.code.actions.copiedTitle' : 'markdownRenderer.table.actions.copyTitle')}>
                <Icon name={copied ? 'check' : 'file-copy'} className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {copyFormats.map((format) => (
                <DropdownMenuItem key={format} onSelect={() => { void copy(format); }}>
                  {formatLabel(format)}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="xs" title={t('markdownRenderer.table.actions.downloadTitle')}>
                <Icon name="download" className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {downloadFormats.map((format) => (
                <DropdownMenuItem key={format} onSelect={() => download(format)}>
                  {formatLabel(format)}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
      <div className="min-w-0 overflow-x-auto">
        <table {...props} ref={ref} data-streamdown="table"
          data-oc-table-layout={widths ? 'fixed' : settled ? 'natural' : 'pending'}
          style={widths ? { ...props.style, width: widths.reduce((sum, width) => sum + width, 0), tableLayout: 'fixed' } : props.style}
          className={cn('border-collapse', className)}>
          {columns && <colgroup>{columns}</colgroup>}
          <TableColumns.Provider value={cellWrap}>{children}</TableColumns.Provider>
        </table>
      </div>
    </div>
  );
}
