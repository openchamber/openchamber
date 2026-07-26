/**
 * VirtualizedCodeBlock — PERF-007
 *
 * Renders large code/read outputs without mounting one highlighter per line:
 *   1. ONE worker tokenization of the whole block (off the main thread)
 *   2. @tanstack/react-virtual to only render visible rows
 *
 * Tokenizing the whole block at once also preserves cross-line syntax context
 * (multi-line strings/comments) that per-line highlighting loses. Colors resolve
 * through the `--md-syntax-*` CSS variables on the container.
 */

import React from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { getMarkdownSyntaxVars } from '@/components/chat/markdown/markdownTheme';
import { useWorkerHighlightedLines } from '@/components/code/useWorkerHighlightedLines';

// ── Threshold: files smaller than this render without virtualization ──
const VIRTUALIZE_THRESHOLD = 80;
const ROW_HEIGHT = 20; // px — matches typography-code line-height

// ── Types ────────────────────────────────────────────────────────────
export interface CodeLine {
  text: string;
  lineNumber?: number | null;
  isInfo?: boolean;
  /** For diff lines */
  type?: 'context' | 'added' | 'removed';
}

interface VirtualizedCodeBlockProps {
  lines: CodeLine[];
  language: string;
  /** Max visible height in CSS (default: 60vh) */
  maxHeight?: string;
  /** Show line numbers (default: true) */
  showLineNumbers?: boolean;
  /** Styles per line type (for diffs) */
  lineStyles?: (line: CodeLine) => React.CSSProperties | undefined;
}

// ── Component ────────────────────────────────────────────────────────
export const VirtualizedCodeBlock: React.FC<VirtualizedCodeBlockProps> = React.memo((props) => {
  const {
    lines,
    language,
    maxHeight = '60vh',
    showLineNumbers = true,
    lineStyles,
  } = props;

  const { currentTheme } = useThemeSystem();
  const syntaxVars = React.useMemo(() => getMarkdownSyntaxVars(currentTheme), [currentTheme]);
  // Tokenize the whole block in one worker call; rows index into the result.
  const fullText = React.useMemo(() => lines.map((line) => line.text).join('\n'), [lines]);
  const highlighted = useWorkerHighlightedLines(fullText, language);

  const shouldVirtualize = lines.length > VIRTUALIZE_THRESHOLD;

  // ── Small file: render directly (no virtualizer overhead) ──
  if (!shouldVirtualize) {
    return (
      <div
        className="typography-code font-mono w-full min-w-0"
        style={{ ...(syntaxVars as React.CSSProperties), maxHeight, overflow: 'auto' }}
      >
        {lines.map((line, idx) => (
          <Row
            key={idx}
            line={line}
            html={highlighted?.[idx]}
            showLineNumbers={showLineNumbers}
            style={lineStyles?.(line)}
          />
        ))}
      </div>
    );
  }

  // ── Large file: virtualise ──
  return (
    <VirtualizedRows
      lines={lines}
      highlighted={highlighted}
      syntaxVars={syntaxVars}
      maxHeight={maxHeight}
      showLineNumbers={showLineNumbers}
      lineStyles={lineStyles}
    />
  );
});

VirtualizedCodeBlock.displayName = 'VirtualizedCodeBlock';

// ── Virtualised container (extracted so the hook is top-level) ────────
interface VirtualizedRowsProps {
  lines: CodeLine[];
  highlighted: string[] | null;
  syntaxVars: Record<string, string>;
  maxHeight: string;
  showLineNumbers: boolean;
  lineStyles?: (line: CodeLine) => React.CSSProperties | undefined;
}

const VirtualizedRows: React.FC<VirtualizedRowsProps> = React.memo(({
  lines,
  highlighted,
  syntaxVars,
  maxHeight,
  showLineNumbers,
  lineStyles,
}) => {
  const parentRef = React.useRef<HTMLDivElement>(null);
  const viewportHeight = `min(${lines.length * ROW_HEIGHT}px, ${maxHeight})`;

  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: lines.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 20,
  });
  const virtualItems = virtualizer.getVirtualItems();

  return (
    <div
      ref={parentRef}
      className="typography-code font-mono w-full min-w-0"
      style={{ ...(syntaxVars as React.CSSProperties), height: viewportHeight, maxHeight, overflow: 'auto' }}
    >
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualItems.map((item) => {
          const line = lines[item.index];
          if (!line) return null;
          return (
            <div
              key={item.index}
              data-index={item.index}
              ref={virtualizer.measureElement}
              style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${item.start}px)` }}
            >
              <Row
                line={line}
                html={highlighted?.[item.index]}
                showLineNumbers={showLineNumbers}
                style={lineStyles?.(line)}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
});

VirtualizedRows.displayName = 'VirtualizedRows';

// ── Single row ───────────────────────────────────────────────────────
interface RowProps {
  line: CodeLine;
  html: string | undefined;
  showLineNumbers: boolean;
  style?: React.CSSProperties;
}

const Row: React.FC<RowProps> = React.memo(({ line, html, showLineNumbers, style }) => {
  return (
    <div
      className="typography-code font-mono flex w-full min-w-0"
      style={style}
    >
      {showLineNumbers && (
        <span
          className="w-10 flex-shrink-0 text-right pr-3 select-none border-r mr-3 -my-0.5 py-0.5"
          style={{ color: 'var(--tools-edit-line-number)', borderColor: 'var(--tools-border)' }}
        >
          {!line.isInfo && line.lineNumber != null ? line.lineNumber : ''}
        </span>
      )}
      <div className="flex-1 min-w-0">
        {line.isInfo ? (
          <div className="whitespace-pre-wrap break-words text-muted-foreground/70 italic">
            {line.text}
          </div>
        ) : html !== undefined ? (
          <div className="whitespace-pre" dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          <div className="whitespace-pre">{line.text}</div>
        )}
      </div>
    </div>
  );
});

Row.displayName = 'VirtualizedCodeBlock.Row';
