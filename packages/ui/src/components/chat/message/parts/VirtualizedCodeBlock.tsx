
import React from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { shownRowsOf } from '@/lib/measure-shown-row';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { getMarkdownSyntaxVars } from '@/components/chat/markdown/markdownSyntaxVars';
import { useHighlightedLines } from '@/components/code/useHighlightedLines';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';

const VIRTUALIZE_THRESHOLD = 80;
const ROW_HEIGHT = 20;

export interface CodeLine {
  text: string;
  lineNumber?: number | null;
  isInfo?: boolean;
  type?: 'context' | 'added' | 'removed';
}

interface VirtualizedCodeBlockProps {
  lines: CodeLine[];
  language: string;
  maxHeight?: string;
  showLineNumbers?: boolean;
  lineStyles?: (line: CodeLine) => React.CSSProperties | undefined;
}

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
  const fullText = React.useMemo(() => lines.map((line) => line.text).join('\n'), [lines]);
  const highlightResult = useHighlightedLines(fullText, language);
  const highlighted = highlightResult.status === 'loading' ? highlightResult.carriedLines : highlightResult.lines;

  const shouldVirtualize = lines.length > VIRTUALIZE_THRESHOLD;

  if (!shouldVirtualize) {
    return (
      <ScrollableOverlay
        outerClassName="oc-surface-code bg-[var(--syntax-background)] min-w-0"
        outerStyle={{ maxHeight }}
        className="typography-code font-mono min-w-0"
        style={syntaxVars as React.CSSProperties}
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
      </ScrollableOverlay>
    );
  }

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

interface VirtualizedRowsProps {
  lines: CodeLine[];
  highlighted: readonly (string | undefined)[] | null;
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
  const parentRef = React.useRef<HTMLElement>(null);
  const viewportHeight = `min(${lines.length * ROW_HEIGHT}px, ${maxHeight})`;

  const virtualizer = useVirtualizer<HTMLElement, HTMLDivElement>({
    count: lines.length,
    getScrollElement: () => parentRef.current,
    ...shownRowsOf(ROW_HEIGHT),
    overscan: 20,
  });
  const virtualItems = virtualizer.getVirtualItems();

  return (
    <ScrollableOverlay
      ref={parentRef}
      outerClassName="oc-surface-code bg-[var(--syntax-background)] min-w-0"
      outerStyle={{ height: viewportHeight, maxHeight }}
      className="typography-code font-mono min-w-0"
      style={syntaxVars as React.CSSProperties}
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
    </ScrollableOverlay>
  );
});

VirtualizedRows.displayName = 'VirtualizedRows';

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
          className="w-10 flex-shrink-0 text-end pe-3 select-none border-e me-3 -my-0.5 py-0.5"
          style={{ color: 'var(--syntax-line-number)', borderColor: 'var(--interactive-border)' }}
        >
          {!line.isInfo && line.lineNumber != null ? line.lineNumber : ''}
        </span>
      )}
      <div className="flex-1 min-w-0">
        {line.isInfo ? (
          <div className="whitespace-pre-wrap break-words text-muted-foreground italic">
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
