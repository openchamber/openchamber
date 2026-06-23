import React from 'react';
import { cn } from '@/lib/utils';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { getMarkdownSyntaxVars } from '@/components/chat/markdown/markdownTheme';
import { highlightCodeInWorker } from '@/components/chat/markdown/markdown-worker';

// Shared static code highlighter backed by the markdown Shiki Web Worker.
//
// Replaces `react-syntax-highlighter` for non-streaming code surfaces (tool
// output, permission previews, diffs, sidebar file contents). The escaped code
// paints synchronously; the worker tokenizes off the main thread and swaps in
// the highlighted markup. Colors resolve through the `--md-syntax-*` CSS
// variables on the host, so theme changes never require re-highlighting.

const escapeHtml = (text: string): string =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const styleString = (style?: React.CSSProperties): string => {
  if (!style) return '';
  return Object.entries(style)
    .map(([key, value]) => {
      if (value == null) return '';
      const prop = key.startsWith('--') ? key : key.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
      return `${prop}:${typeof value === 'number' ? `${value}px` : value};`;
    })
    .join('');
};

// Normalize a worker/plain `<pre><code>` so it sits flush inside the host: drop
// Shiki's own background/margin and apply wrap + caller code styles.
const applyPreStyles = (host: HTMLElement, wrap: boolean, codeStyle?: React.CSSProperties): void => {
  const pre = host.querySelector('pre');
  if (pre) {
    pre.style.margin = '0';
    pre.style.background = 'transparent';
    pre.style.whiteSpace = wrap ? 'pre-wrap' : 'pre';
    if (wrap) {
      pre.style.wordBreak = 'break-word';
      pre.style.overflowWrap = 'break-word';
    }
  }
  const code = host.querySelector('code');
  if (code) {
    const extra = styleString(codeStyle);
    if (extra) code.setAttribute('style', `${code.getAttribute('style') ?? ''}${extra}`);
  }
};

const plainHtml = (code: string): string => `<pre><code>${escapeHtml(code)}</code></pre>`;

export interface WorkerHighlightedCodeProps {
  code: string;
  language: string;
  className?: string;
  /** Inline styles for the host container (mirrors react-syntax-highlighter `customStyle`). */
  style?: React.CSSProperties;
  /** Inline styles applied to the `<code>` element (mirrors `codeTagProps.style`). */
  codeStyle?: React.CSSProperties;
  /** Wrap long lines instead of horizontal scroll. */
  wrap?: boolean;
}

export const WorkerHighlightedCode: React.FC<WorkerHighlightedCodeProps> = ({
  code,
  language,
  className,
  style,
  codeStyle,
  wrap = false,
}) => {
  const { currentTheme } = useThemeSystem();
  const hostRef = React.useRef<HTMLDivElement>(null);
  const syntaxVars = React.useMemo(() => getMarkdownSyntaxVars(currentTheme), [currentTheme]);

  // Synchronous escaped first paint — no blank frame before highlighting lands.
  React.useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    host.innerHTML = plainHtml(code);
    applyPreStyles(host, wrap, codeStyle);
  }, [code, wrap, codeStyle]);

  // Highlight off the main thread, then swap in. Guarded against stale results.
  React.useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let active = true;
    void highlightCodeInWorker(code, (language || 'text').toLowerCase()).then((html) => {
      if (!active || !host || !html) return;
      host.innerHTML = html;
      applyPreStyles(host, wrap, codeStyle);
    });
    return () => {
      active = false;
    };
  }, [code, language, wrap, codeStyle]);

  return (
    <div
      ref={hostRef}
      className={cn('typography-code', className)}
      style={{ ...(syntaxVars as React.CSSProperties), ...style }}
    />
  );
};
