/**
 * VirtualizedCodeBlock — PERF-007
 *
 * Replaces per-line <SyntaxHighlighter> with:
 *   1. ONE Prism.highlight() call to tokenize all code at once
 *   2. @tanstack/react-virtual to only render visible rows
 *
 * This drops mount cost from O(N * Prism) to O(1 * Prism) + O(visible_rows).
 * For a 2000-line file, ~2000 SyntaxHighlighter instances → ~30 plain <div>s.
 */

import React from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import Prism from 'prismjs';

// Ensure common languages are loaded (react-syntax-highlighter lazy-loads them,
// but we call Prism directly so we need them registered).
import 'prismjs/components/prism-markup';
import 'prismjs/components/prism-markup-templating';
import 'prismjs/components/prism-typescript';
import 'prismjs/components/prism-javascript';
import 'prismjs/components/prism-jsx';
import 'prismjs/components/prism-tsx';
import 'prismjs/components/prism-css';
import 'prismjs/components/prism-json';
import 'prismjs/components/prism-bash';
import 'prismjs/components/prism-python';
import 'prismjs/components/prism-rust';
import 'prismjs/components/prism-go';
import 'prismjs/components/prism-java';
import 'prismjs/components/prism-c';
import 'prismjs/components/prism-cpp';
import 'prismjs/components/prism-csharp';
import 'prismjs/components/prism-ruby';
import 'prismjs/components/prism-yaml';
import 'prismjs/components/prism-toml';
import 'prismjs/components/prism-markdown';
import 'prismjs/components/prism-sql';
import 'prismjs/components/prism-diff';
import 'prismjs/components/prism-docker';
import 'prismjs/components/prism-swift';
import 'prismjs/components/prism-kotlin';
import 'prismjs/components/prism-lua';
import 'prismjs/components/prism-php';
import 'prismjs/components/prism-scss';

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
  syntaxTheme: Record<string, React.CSSProperties>;
  /** Max visible height in CSS (default: 60vh) */
  maxHeight?: string;
  /** Show line numbers (default: true) */
  showLineNumbers?: boolean;
  /** Styles per line type (for diffs) */
  lineStyles?: (line: CodeLine) => React.CSSProperties | undefined;
}

const toKebabCase = (value: string): string => value.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);

const styleObjectToCss = (style: React.CSSProperties): string => {
  return Object.entries(style)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${toKebabCase(k)}:${String(v)};`)
    .join('');
};

const buildSelectorList = (rawKey: string): string[] => {
  return rawKey
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .flatMap((selector) => {
      if (selector.startsWith('.token')) {
        return [`.oc-virtualized-prism ${selector}`];
      }
      if (selector.startsWith('token.')) {
        return [`.oc-virtualized-prism .${selector}`];
      }
      if (/^[a-z0-9_-]+$/i.test(selector)) {
        return [`.oc-virtualized-prism .token.${selector}`];
      }
      if (selector.includes('token')) {
        return [`.oc-virtualized-prism ${selector}`];
      }
      return [];
    });
};

const buildPrismThemeCss = (theme: Record<string, React.CSSProperties>): string => {
  const rules: string[] = [];
  Object.entries(theme).forEach(([rawKey, style]) => {
    const selectors = buildSelectorList(rawKey);
    if (selectors.length === 0) {
      return;
    }
    const css = styleObjectToCss(style);
    if (!css) {
      return;
    }
    rules.push(`${selectors.join(',')}{${css}}`);
  });
  return rules.join('\n');
};

const LANGUAGE_ALIASES: Record<string, string> = {
  text: 'plain',
  plaintext: 'plain',
  shell: 'bash',
  sh: 'bash',
  zsh: 'bash',
  patch: 'diff',
  dockerfile: 'docker',
  js: 'javascript',
  ts: 'typescript',
};

const normalizeLanguage = (language: string): string => {
  const lower = language.toLowerCase();
  return LANGUAGE_ALIASES[lower] ?? lower;
};

const HIGHLIGHT_CACHE_MAX = 5000;
const highlightCache = new Map<string, string>();

const highlightLine = (text: string, language: string): string => {
  const normalizedLanguage = normalizeLanguage(language);
  const cacheKey = `${normalizedLanguage}\n${text}`;
  const cached = highlightCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const grammar = Prism.languages[normalizedLanguage] ?? Prism.languages.text;
  if (!grammar) {
    const escaped = escapeHtml(text);
    highlightCache.set(cacheKey, escaped);
    return escaped;
  }

  try {
    const highlighted = Prism.highlight(text, grammar, normalizedLanguage);
    if (highlightCache.size >= HIGHLIGHT_CACHE_MAX) {
      const oldestKey = highlightCache.keys().next().value;
      if (typeof oldestKey === 'string') {
        highlightCache.delete(oldestKey);
      }
    }
    highlightCache.set(cacheKey, highlighted);
    return highlighted;
  } catch {
    const escaped = escapeHtml(text);
    highlightCache.set(cacheKey, escaped);
    return escaped;
  }
};

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ── Component ────────────────────────────────────────────────────────
export const VirtualizedCodeBlock: React.FC<VirtualizedCodeBlockProps> = React.memo((props) => {
  const {
    lines,
    language,
    syntaxTheme,
    maxHeight = '60vh',
    showLineNumbers = true,
    lineStyles,
  } = props;
  const prismThemeCss = React.useMemo(() => buildPrismThemeCss(syntaxTheme), [syntaxTheme]);

  const shouldVirtualize = lines.length > VIRTUALIZE_THRESHOLD;

  // ── Small file: render directly (no virtualizer overhead) ──
  if (!shouldVirtualize) {
    return (
      <div
        className="typography-code font-mono w-full min-w-0 oc-virtualized-prism"
        style={{ maxHeight, overflow: 'auto' }}
      >
        {prismThemeCss ? <style>{prismThemeCss}</style> : null}
        {lines.map((line, idx) => (
          <Row
            key={idx}
            line={line}
            language={language}
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
      language={language}
      prismThemeCss={prismThemeCss}
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
  language: string;
  prismThemeCss: string;
  maxHeight: string;
  showLineNumbers: boolean;
  lineStyles?: (line: CodeLine) => React.CSSProperties | undefined;
}

const VirtualizedRows: React.FC<VirtualizedRowsProps> = React.memo(({
  lines,
  language,
  prismThemeCss,
  maxHeight,
  showLineNumbers,
  lineStyles,
}) => {
  const parentRef = React.useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 20, // render 20 extra rows above/below viewport
  });

  return (
    <div
      ref={parentRef}
      className="typography-code font-mono w-full min-w-0 oc-virtualized-prism"
      style={{ maxHeight, overflow: 'auto' }}
    >
      {prismThemeCss ? <style>{prismThemeCss}</style> : null}
      <div
        style={{
          height: `${virtualizer.getTotalSize()}px`,
          width: '100%',
          position: 'relative',
        }}
      >
        {virtualizer.getVirtualItems().map((vItem) => {
          const line = lines[vItem.index];
          return (
            <div
              key={vItem.index}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                height: `${vItem.size}px`,
                transform: `translateY(${vItem.start}px)`,
              }}
            >
              <Row
                line={line}
                language={language}
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
  language: string;
  showLineNumbers: boolean;
  style?: React.CSSProperties;
}

const Row: React.FC<RowProps> = React.memo(({ line, language, showLineNumbers, style }) => {
  const html = React.useMemo(() => highlightLine(line.text, language), [line.text, language]);

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
        ) : (
          <div
            className="whitespace-pre"
            dangerouslySetInnerHTML={{ __html: html }}
          />
        )}
      </div>
    </div>
  );
});

Row.displayName = 'VirtualizedCodeBlock.Row';
