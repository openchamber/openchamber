import React from 'react';
import { cn } from '@/lib/utils';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { getMarkdownSyntaxVars } from '@/components/chat/markdown/markdownSyntaxVars';
import { getHighlightedCode, highlightCode } from '@/components/chat/markdown/highlightedCode';

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

interface HighlightedCodeProps {
  code: string;
  language: string;
  className?: string;
  style?: React.CSSProperties;
  codeStyle?: React.CSSProperties;
  wrap?: boolean;
}

export const HighlightedCode: React.FC<HighlightedCodeProps> = ({
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

  React.useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    host.innerHTML = getHighlightedCode(code, (language || 'text').toLowerCase()) ?? plainHtml(code);
    applyPreStyles(host, wrap, codeStyle);
  }, [code, language, wrap, codeStyle]);

  React.useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    if (getHighlightedCode(code, (language || 'text').toLowerCase())) return;
    let active = true;
    void highlightCode(code, (language || 'text').toLowerCase()).then((html) => {
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
      className={cn('oc-surface-code bg-[var(--syntax-background)] typography-code', className)}
      // SAFETY: the variables are CSS custom properties, which CSSProperties has no keys for.
      style={{ ...(syntaxVars as React.CSSProperties), ...style }}
    />
  );
};
