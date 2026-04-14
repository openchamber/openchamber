import React from 'react';
import { renderMermaidASCII, renderMermaidSVG } from 'beautiful-mermaid';
import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { marked, type Tokens } from 'marked';
import remend from 'remend';
import { FadeInOnReveal } from './message/FadeInOnReveal';
import type { Part } from '@opencode-ai/sdk/v2';
import { cn } from '@/lib/utils';
import { RiFileCopyLine, RiCheckLine, RiDownloadLine } from '@remixicon/react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { toast } from '@/components/ui';
import { copyTextToClipboard } from '@/lib/clipboard';

import { isExternalHttpUrl, openExternalUrl } from '@/lib/url';
import { useOptionalThemeSystem } from '@/contexts/useThemeSystem';
import { getDefaultTheme } from '@/lib/theme/themes';
import { generateSyntaxTheme } from '@/lib/theme/syntaxThemeGenerator';
import type { ToolPopupContent } from './message/types';
import { useUIStore } from '@/stores/useUIStore';
import { useDeviceInfo } from '@/lib/device';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type { EditorAPI } from '@/lib/api/types';

const useCurrentMermaidTheme = () => {
  const themeSystem = useOptionalThemeSystem();
  const fallbackLight = getDefaultTheme(false);
  const fallbackDark = getDefaultTheme(true);

  return themeSystem?.currentTheme
    ?? (typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches
      ? fallbackDark
      : fallbackLight);
};

const useExternalLinkInteractions = ({
  containerRef,
  enabled,
}: {
  containerRef: React.RefObject<HTMLDivElement | null>;
  enabled?: boolean;
}) => {
  React.useEffect(() => {
    if (enabled === false) {
      return;
    }

    const container = containerRef.current;
    if (!container) {
      return;
    }

    const handleClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) {
        return;
      }

      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }

      const anchor = target.closest('a[href]');
      if (!(anchor instanceof HTMLAnchorElement)) {
        return;
      }

      if (anchor.getAttribute('data-openchamber-file-link') === 'true') {
        return;
      }

      const href = anchor.getAttribute('href') ?? '';
      if (!isExternalHttpUrl(href)) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      void openExternalUrl(href);
    };

    container.addEventListener('click', handleClick);
    return () => {
      container.removeEventListener('click', handleClick);
    };
  }, [containerRef, enabled]);
};

// Table utility functions
const extractTableData = (tableEl: HTMLTableElement): { headers: string[]; rows: string[][] } => {
  const headers: string[] = [];
  const rows: string[][] = [];
  
  const thead = tableEl.querySelector('thead');
  if (thead) {
    const headerCells = thead.querySelectorAll('th');
    headerCells.forEach(cell => headers.push(cell.innerText.trim()));
  }
  
  const tbody = tableEl.querySelector('tbody');
  if (tbody) {
    const rowEls = tbody.querySelectorAll('tr');
    rowEls.forEach(row => {
      const cells = row.querySelectorAll('td');
      const rowData: string[] = [];
      cells.forEach(cell => rowData.push(cell.innerText.trim()));
      rows.push(rowData);
    });
  }
  
  return { headers, rows };
};

const tableToCSV = ({ headers, rows }: { headers: string[]; rows: string[][] }): string => {
  const escapeCell = (cell: string): string => {
    if (cell.includes(',') || cell.includes('"') || cell.includes('\n')) {
      return `"${cell.replace(/"/g, '""')}"`;
    }
    return cell;
  };
  
  const lines: string[] = [];
  if (headers.length > 0) {
    lines.push(headers.map(escapeCell).join(','));
  }
  rows.forEach(row => lines.push(row.map(escapeCell).join(',')));
  return lines.join('\n');
};

const tableToTSV = ({ headers, rows }: { headers: string[]; rows: string[][] }): string => {
  const escapeCell = (cell: string): string => {
    return cell.replace(/\t/g, '\\t').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
  };
  
  const lines: string[] = [];
  if (headers.length > 0) {
    lines.push(headers.map(escapeCell).join('\t'));
  }
  rows.forEach(row => lines.push(row.map(escapeCell).join('\t')));
  return lines.join('\n');
};

const tableToMarkdown = ({ headers, rows }: { headers: string[]; rows: string[][] }): string => {
  if (headers.length === 0) return '';
  
  const escapeCell = (cell: string): string => {
    return cell.replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
  };
  
  const lines: string[] = [];
  lines.push(`| ${headers.map(escapeCell).join(' | ')} |`);
  lines.push(`| ${headers.map(() => '---').join(' | ')} |`);
  rows.forEach(row => {
    const paddedRow = headers.map((_, i) => escapeCell(row[i] || ''));
    lines.push(`| ${paddedRow.join(' | ')} |`);
  });
  return lines.join('\n');
};

const downloadFile = (filename: string, content: string, mimeType: string) => {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
};

// Table copy button with dropdown
const TableCopyButton: React.FC<{ tableRef: React.RefObject<HTMLDivElement | null> }> = ({ tableRef }) => {
  const [copied, setCopied] = React.useState(false);
  const [showMenu, setShowMenu] = React.useState(false);
  const menuRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleCopy = async (format: 'csv' | 'tsv') => {
    const tableEl = tableRef.current?.querySelector('table');
    if (!tableEl) return;
    
    const data = extractTableData(tableEl);
    const content = format === 'csv' ? tableToCSV(data) : tableToTSV(data);

    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/plain': new Blob([content], { type: 'text/plain' }),
          'text/html': new Blob([tableEl.outerHTML], { type: 'text/html' }),
        }),
      ]);
      setCopied(true);
      setShowMenu(false);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      const fallbackResult = await copyTextToClipboard(content);
      if (fallbackResult.ok) {
        setCopied(true);
        setShowMenu(false);
        setTimeout(() => setCopied(false), 2000);
        return;
      }
      console.error('Failed to copy table:', err);
    }
  };

  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={() => setShowMenu(!showMenu)}
        className="p-1 rounded hover:bg-interactive-hover/60 text-muted-foreground hover:text-foreground transition-colors"
        title="Copy table"
      >
        {copied ? <RiCheckLine className="size-3.5" /> : <RiFileCopyLine className="size-3.5" />}
      </button>
      {showMenu && (
        <div className="absolute top-full right-0 z-10 mt-1 min-w-[100px] overflow-hidden rounded-md border border-border bg-background shadow-none">
          <button
            className="w-full px-3 py-1.5 text-left text-sm transition-colors hover:bg-interactive-hover/40"
            onClick={() => handleCopy('csv')}
          >
            CSV
          </button>
          <button
            className="w-full px-3 py-1.5 text-left text-sm transition-colors hover:bg-interactive-hover/40"
            onClick={() => handleCopy('tsv')}
          >
            TSV
          </button>
        </div>
      )}
    </div>
  );
};

// Table download button with dropdown
const TableDownloadButton: React.FC<{ tableRef: React.RefObject<HTMLDivElement | null> }> = ({ tableRef }) => {
  const [showMenu, setShowMenu] = React.useState(false);
  const menuRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

   const handleDownload = (format: 'csv' | 'markdown') => {
      const tableEl = tableRef.current?.querySelector('table');
      if (!tableEl) return;

      const data = extractTableData(tableEl);
      const content = format === 'csv' ? tableToCSV(data) : tableToMarkdown(data);
      const filename = format === 'csv' ? 'table.csv' : 'table.md';
      const mimeType = format === 'csv' ? 'text/csv' : 'text/markdown';
      downloadFile(filename, content, mimeType);
      setShowMenu(false);
      toast.success(`Table downloaded as ${format.toUpperCase()}`);
    };

  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={() => setShowMenu(!showMenu)}
        className="p-1 rounded hover:bg-interactive-hover/60 text-muted-foreground hover:text-foreground transition-colors"
        title="Download table"
      >
        <RiDownloadLine className="size-3.5" />
      </button>
      {showMenu && (
        <div className="absolute top-full right-0 z-10 mt-1 min-w-[100px] overflow-hidden rounded-md border border-border bg-background shadow-none">
          <button
            className="w-full px-3 py-1.5 text-left text-sm transition-colors hover:bg-interactive-hover/40"
            onClick={() => handleDownload('csv')}
          >
            CSV
          </button>
          <button
            className="w-full px-3 py-1.5 text-left text-sm transition-colors hover:bg-interactive-hover/40"
            onClick={() => handleDownload('markdown')}
          >
            Markdown
          </button>
        </div>
      )}
    </div>
  );
};

// Table wrapper with custom controls
const TableWrapper: React.FC<{ children?: React.ReactNode; className?: string }> = ({ children, className }) => {
  const tableRef = React.useRef<HTMLDivElement>(null);

  return (
    <div className="group my-4 flex flex-col space-y-2" data-markdown="table-wrapper" ref={tableRef}>
      <div className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <TableCopyButton tableRef={tableRef} />
        <TableDownloadButton tableRef={tableRef} />
      </div>
      <div className="overflow-x-auto rounded-lg border border-border/80 bg-[var(--surface-elevated)]">
        <table className={cn('w-full border-collapse text-sm', className)} data-markdown="table">
          {children}
        </table>
      </div>
    </div>
  );
};

const MermaidBlock: React.FC<{ source: string; mode: 'svg' | 'ascii' }> = ({ source, mode }) => {
  const currentTheme = useCurrentMermaidTheme();
  const { isMobile } = useDeviceInfo();
  const [copied, setCopied] = React.useState(false);
  const [downloaded, setDownloaded] = React.useState(false);

  const svg = React.useMemo(() => {
    if (mode !== 'svg') return '';
    try {
      return renderMermaidSVG(source, {
        bg: currentTheme.colors.surface.elevated,
        fg: currentTheme.colors.surface.foreground,
        line: currentTheme.colors.interactive.border,
        accent: currentTheme.colors.primary.base,
        muted: currentTheme.colors.surface.mutedForeground,
        surface: currentTheme.colors.surface.muted,
        border: currentTheme.colors.interactive.border,
        transparent: true,
        font: 'IBM Plex Sans, sans-serif',
      });
    } catch {
      return '';
    }
  }, [currentTheme, mode, source]);

  const ascii = React.useMemo(() => {
    if (mode !== 'ascii') return '';
    try {
      return renderMermaidASCII(source);
    } catch {
      return '';
    }
  }, [mode, source]);

  const copyVisibilityClass = isMobile ? 'opacity-100' : 'opacity-0 group-hover:opacity-100';

  const handleCopyAscii = async (asciiText: string) => {
    if (!asciiText) return;
    const result = await copyTextToClipboard(asciiText);
    if (result.ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleCopyMermaidSource = async () => {
    if (!source) return;
    const result = await copyTextToClipboard(source);
    if (result.ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleDownloadSvg = () => {
    if (!svg) return;
    try {
      const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `diagram-${Date.now()}.svg`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      setDownloaded(true);
      setTimeout(() => setDownloaded(false), 2000);
    } catch {
      toast.error('Failed to download diagram');
    }
  };

  if (mode === 'ascii') {
    const asciiText = ascii || source;

    return (
      <div data-markdown="mermaid-block" className="group">
        <div data-markdown="mermaid-scroll">
          <pre data-markdown="mermaid-ascii">{asciiText}</pre>
        </div>
        <div
          className={cn(
            'absolute top-1 right-2 transition-opacity',
            copyVisibilityClass,
          )}
        >
          <button
            onClick={() => handleCopyAscii(asciiText)}
            className="p-1 rounded hover:bg-interactive-hover/60 text-muted-foreground hover:text-foreground transition-colors"
            title="Copy"
          >
            {copied ? <RiCheckLine className="size-3.5" /> : <RiFileCopyLine className="size-3.5" />}
          </button>
        </div>
      </div>
    );
  }

  if (!svg) {
    return (
      <div data-markdown="mermaid-block" className="group">
        <div data-markdown="mermaid-scroll">
          <pre data-markdown="mermaid-ascii">{source}</pre>
        </div>
        <div
          className={cn(
            'absolute top-1 right-2 transition-opacity',
            copyVisibilityClass,
          )}
        >
          <button
            onClick={() => handleCopyAscii(source)}
            className="p-1 rounded hover:bg-interactive-hover/60 text-muted-foreground hover:text-foreground transition-colors"
            title="Copy"
          >
            {copied ? <RiCheckLine className="size-3.5" /> : <RiFileCopyLine className="size-3.5" />}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div data-markdown="mermaid-block" className="group">
      <div data-markdown="mermaid-scroll">
        <div data-markdown="mermaid" dangerouslySetInnerHTML={{ __html: svg }} />
      </div>
      <div
        className={cn(
          'absolute top-1 right-2 flex items-center gap-1 transition-opacity',
          copyVisibilityClass,
        )}
      >
        <button
          onClick={handleCopyMermaidSource}
          className="p-1 rounded hover:bg-interactive-hover/60 text-muted-foreground hover:text-foreground transition-colors"
          title="Copy source"
        >
          {copied ? <RiCheckLine className="size-3.5" /> : <RiFileCopyLine className="size-3.5" />}
        </button>
        <button
          onClick={handleDownloadSvg}
          className="p-1 rounded hover:bg-interactive-hover/60 text-muted-foreground hover:text-foreground transition-colors"
          title="Download SVG"
        >
          {downloaded ? <RiCheckLine className="size-3.5" /> : <RiDownloadLine className="size-3.5" />}
        </button>
      </div>
    </div>
  );
};

type MermaidControlOptions = {
  download: boolean;
  copy: boolean;
  fullscreen: boolean;
  panZoom: boolean;
};

const extractMermaidBlocks = (markdown: string): string[] => {
  const blocks: string[] = [];
  const regex = /(?:^|\r?\n)(`{3,}|~{3,})mermaid[^\n\r]*\r?\n([\s\S]*?)\r?\n\1(?=\r?\n|$)/gi;
  let match: RegExpExecArray | null = regex.exec(markdown);

  while (match) {
    const block = (match[2] ?? '').replace(/\s+$/, '');
    blocks.push(block);
    match = regex.exec(markdown);
  }

  return blocks;
};

const stripLeadingFrontmatter = (markdown: string): string => {
  const frontmatterMatch = markdown.match(
    /^(?:\uFEFF)?(---|\+\+\+)[^\S\r\n]*\r?\n[\s\S]*?\r?\n\1[^\S\r\n]*(?:\r?\n|$)/,
  );

  if (!frontmatterMatch) {
    return markdown;
  }

  return markdown.slice(frontmatterMatch[0].length);
};

export type MarkdownVariant = 'assistant' | 'tool' | 'reasoning';

type MarkdownStreamBlock = {
  key: string;
  raw: string;
  src: string;
  mode: 'full' | 'live';
};

const hasReferenceDefinitions = (text: string): boolean => {
  return /^\[[^\]]+\]:\s+\S+/m.test(text) || /^\[\^[^\]]+\]:\s+/m.test(text);
};

const hasOpenFence = (raw: string): boolean => {
  const match = raw.match(/^[ \t]{0,3}(`{3,}|~{3,})/);
  if (!match) return false;
  const marker = match[1];
  if (!marker) return false;
  const char = marker[0];
  const size = marker.length;
  const last = raw.trimEnd().split('\n').at(-1)?.trim() ?? '';
  return !new RegExp(`^[\\t ]{0,3}${char}{${size},}[\\t ]*$`).test(last);
};

const healMarkdown = (text: string): string => {
  return remend(text, { linkMode: 'text-only' });
};

const fnv1a32 = (input: string): string => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash.toString(16);
};

const buildMarkdownCacheKey = (baseKey: string, raw: string, index: number, mode: 'full' | 'live'): string => {
  const sample = raw.length > 400 ? `${raw.slice(0, 200)}${raw.slice(-200)}` : raw;
  return `${baseKey}:${index}:${mode}:${raw.length}:${fnv1a32(sample)}`;
};

const streamMarkdownBlocks = (text: string, live: boolean, baseKey: string): MarkdownStreamBlock[] => {
  if (!live) {
    return [{
      key: buildMarkdownCacheKey(baseKey, text, 0, 'full'),
      raw: text,
      src: text,
      mode: 'full',
    }];
  }

  const healed = healMarkdown(text);
  if (hasReferenceDefinitions(text)) {
    return [{
      key: buildMarkdownCacheKey(baseKey, text, 0, 'live'),
      raw: text,
      src: healed,
      mode: 'live',
    }];
  }

  const tokens = marked.lexer(text);
  const blocks: MarkdownStreamBlock[] = [];
  let blockIndex = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] as Tokens.Generic;
    if (token.type === 'space') {
      continue;
    }

    const raw = token.raw ?? '';
    const isLast = index === tokens.length - 1 || tokens.slice(index + 1).every((nextToken) => nextToken.type === 'space');
    const mode: 'full' | 'live' = isLast ? 'live' : 'full';
    const src = isLast && token.type === 'code' && hasOpenFence(raw)
      ? raw
      : healMarkdown(raw);

    blocks.push({
      key: buildMarkdownCacheKey(baseKey, raw, blockIndex, mode),
      raw,
      src,
      mode,
    });
    blockIndex += 1;
  }

  if (blocks.length === 0) {
    return [{
      key: buildMarkdownCacheKey(baseKey, text, 0, 'live'),
      raw: text,
      src: healed,
      mode: 'live',
    }];
  }

  return blocks;
};

const useStableMarkdownBlocks = (text: string, live: boolean, baseKey: string): MarkdownStreamBlock[] => {
  const previousRef = React.useRef<MarkdownStreamBlock[]>([]);

  return React.useMemo(() => {
    const nextBlocks = streamMarkdownBlocks(text, live, baseKey);
    const previousBlocks = previousRef.current;
    const stabilized = nextBlocks.map((block, index) => {
      const previous = previousBlocks[index];
      if (previous && previous.key === block.key && previous.src === block.src) {
        return previous;
      }
      return block;
    });

    const unchanged = stabilized.length === previousBlocks.length
      && stabilized.every((block, index) => block === previousBlocks[index]);

    if (unchanged) {
      return previousBlocks;
    }

    previousRef.current = stabilized;
    return stabilized;
  }, [baseKey, live, text]);
};

const extractCodeText = (children: React.ReactNode): string => {
  if (typeof children === 'string') return children;
  if (Array.isArray(children)) {
    return children.map((child) => extractCodeText(child)).join('');
  }
  if (React.isValidElement(children)) {
    return extractCodeText((children.props as { children?: React.ReactNode }).children);
  }
  return '';
};

const getCodeLanguage = (className: string | undefined): string => {
  const match = className?.match(/language-([\w-]+)/);
  return match?.[1]?.toLowerCase() ?? 'text';
};

const decodeHtmlEntities = (value: string): string => {
  let decoded = value;
  for (let i = 0; i < 3; i += 1) {
    const next = decoded
      .replace(/&quot;/g, '"')
      .replace(/&#34;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
    if (next === decoded) {
      return decoded;
    }
    decoded = next;
  }
  return decoded;
};

const normalizeCodeBlockText = (code: string, language: string): string => {
  if (!['json', 'jsonc', 'json5'].includes(language)) {
    return code;
  }
  if (!/&(quot|#34|amp;quot|lt|gt|amp|apos|#39);/.test(code)) {
    return code;
  }
  return decodeHtmlEntities(code);
};

const MarkdownCodeBlock: React.FC<{
  code: string;
  language: string;
  syntaxTheme: { [key: string]: React.CSSProperties };
}> = ({ code, language, syntaxTheme }) => {
  const [copied, setCopied] = React.useState(false);

  const handleCopy = React.useCallback(async () => {
    const result = await copyTextToClipboard(code);
    if (!result.ok) return;
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  }, [code]);

  return (
    <div data-component="markdown-code" className="my-4 group overflow-hidden rounded-2xl border border-border/80 bg-[var(--surface-elevated)]">
      <div className="flex items-center justify-between border-b border-border/70 px-3 py-1.5">
        <span className="font-mono text-[13px] text-muted-foreground">{language}</span>
        <div className="opacity-0 transition-opacity group-hover:opacity-100">
          <button
            type="button"
            onClick={() => { void handleCopy(); }}
            className="p-1 rounded hover:bg-interactive-hover/60 text-muted-foreground hover:text-foreground transition-colors"
            title={copied ? 'Copied' : 'Copy code'}
          >
            {copied ? <RiCheckLine className="size-3.5" /> : <RiFileCopyLine className="size-3.5" />}
          </button>
        </div>
      </div>
      <div className="px-3 py-2.5">
        <SyntaxHighlighter
          language={language}
          style={syntaxTheme}
          customStyle={{ margin: 0, background: 'transparent', padding: 0, fontSize: 'var(--text-code)', lineHeight: 'var(--markdown-code-block-line-height)' }}
          codeTagProps={{ style: { fontSize: 'var(--text-code)', lineHeight: 'var(--markdown-code-block-line-height)' } }}
          PreTag="pre"
        >
          {code}
        </SyntaxHighlighter>
      </div>
    </div>
  );
};

const buildMarkdownComponents = ({
  syntaxTheme,
}: {
  syntaxTheme: { [key: string]: React.CSSProperties };
}): Components => ({
  table({ children, ...props }) {
    return <TableWrapper className={props.className}>{children}</TableWrapper>;
  },
  h1({ children, ...props }) {
    return <h1 {...props} className={cn('typography-markdown-h1 mt-4 mb-2 text-[var(--markdown-heading1,var(--primary))] font-semibold', props.className)}>{children}</h1>;
  },
  h2({ children, ...props }) {
    return <h2 {...props} className={cn('typography-markdown-h2 mt-3.5 mb-1.5 text-[var(--markdown-heading2,var(--primary))] font-semibold', props.className)}>{children}</h2>;
  },
  h3({ children, ...props }) {
    return <h3 {...props} className={cn('typography-markdown-h3 mt-3 mb-1 text-[var(--markdown-heading3,var(--primary))] font-semibold', props.className)}>{children}</h3>;
  },
  h4({ children, ...props }) {
    return <h4 {...props} className={cn('typography-markdown-h4 mt-2.5 mb-1 text-[var(--markdown-heading4,var(--foreground))] font-semibold', props.className)}>{children}</h4>;
  },
  h5({ children, ...props }) {
    return <h5 {...props} className={cn('typography-markdown-h4 mt-2.5 mb-1 text-[var(--markdown-heading4,var(--foreground))] font-semibold', props.className)}>{children}</h5>;
  },
  h6({ children, ...props }) {
    return <h6 {...props} className={cn('typography-markdown-h4 mt-2.5 mb-1 text-[var(--markdown-heading4,var(--foreground))] font-semibold', props.className)}>{children}</h6>;
  },
  p({ children, ...props }) {
    return <p {...props} className={cn('typography-markdown-body my-2 text-foreground/90', props.className)}>{children}</p>;
  },
  thead({ children, ...props }) {
    return <thead {...props} className={cn('[&_tr]:border-b [&_tr]:border-border/80', props.className)}>{children}</thead>;
  },
  tbody({ children, ...props }) {
    return <tbody {...props} className={cn('[&_tr:last-child]:border-0', props.className)}>{children}</tbody>;
  },
  tr({ children, ...props }) {
    return <tr {...props} className={cn('border-b border-border/60', props.className)}>{children}</tr>;
  },
  th({ children, ...props }) {
    return <th {...props} className={cn('border-r border-border/60 px-4 py-2.5 text-left align-middle font-semibold text-foreground last:border-r-0', props.className)}>{children}</th>;
  },
  td({ children, ...props }) {
    return <td {...props} className={cn('border-r border-border/60 px-4 py-2.5 align-middle text-foreground/90 last:border-r-0', props.className)}>{children}</td>;
  },
  ul({ children, ...props }) {
    return <ul {...props} className={cn('typography-markdown-body my-2', props.className)}>{children}</ul>;
  },
  ol({ children, ...props }) {
    return <ol {...props} className={cn('typography-markdown-body my-2', props.className)}>{children}</ol>;
  },
  li({ children, ...props }) {
    return <li {...props} className={cn('typography-markdown-body my-0.5 text-foreground/90', props.className)}>{children}</li>;
  },
  blockquote({ children, ...props }) {
    return <blockquote {...props} className={cn('my-3 border-l-2 border-[var(--markdown-blockquote-border,var(--border))] pl-4 typography-markdown-body text-[var(--markdown-blockquote,var(--muted-foreground))]', props.className)}>{children}</blockquote>;
  },
  pre({ children, ...props }) {
    const child = React.Children.only(children) as React.ReactElement<{ className?: string; children?: React.ReactNode }>;
    const className = child.props.className;
    const language = getCodeLanguage(className);
    const code = normalizeCodeBlockText(extractCodeText(child.props.children).replace(/\n$/, ''), language);
    if (language === 'mermaid') {
      return <MermaidBlock source={code} mode={useUIStore.getState().mermaidRenderingMode} />;
    }
    return <MarkdownCodeBlock code={code} language={language} syntaxTheme={syntaxTheme} {...props} />;
  },
  code({ className, children, ...props }) {
    return (
      <code
        {...props}
        className={cn('rounded bg-[var(--surface-elevated)] px-1 py-0.5 font-mono text-[0.95em]', className)}
        data-markdown="inline-code"
      >
        {children}
      </code>
    );
  },
  a({ href, children, ...props }) {
    return (
      <a
        {...props}
        href={href}
        target={isExternalHttpUrl(href ?? '') ? '_blank' : undefined}
        rel={isExternalHttpUrl(href ?? '') ? 'noopener noreferrer' : undefined}
      >
        {children}
      </a>
    );
  },
});

const MarkdownBlockView: React.FC<{
  block: MarkdownStreamBlock;
  components: Components;
}> = React.memo(({ block, components }) => {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
      {block.src}
    </ReactMarkdown>
  );
}, (prev, next) => prev.block === next.block && prev.components === next.components);

MarkdownBlockView.displayName = 'MarkdownBlockView';

interface MarkdownRendererProps {
  content: string;
  part?: Part;
  messageId: string;
  isAnimated?: boolean;
  skipFadeIn?: boolean;
  className?: string;
  isStreaming?: boolean;
  disableStreamAnimation?: boolean;
  variant?: MarkdownVariant;
  onShowPopup?: (content: ToolPopupContent) => void;
}

const MERMAID_BLOCK_SELECTOR = '[data-markdown="mermaid-block"]';
const FILE_LINK_SELECTOR = '[data-openchamber-file-link="true"]';

type ParsedFileReference = {
  path: string;
  line?: number;
  column?: number;
};

const WINDOWS_DRIVE_PATH_PATTERN = /^[A-Za-z]:[\\/]/;
const WINDOWS_UNC_PATH_PATTERN = /^\\\\[^\\]+\\[^\\]+/;
const KNOWN_FILE_BASENAMES = new Set([
  'dockerfile',
  'makefile',
  'readme',
  'license',
  '.env',
  '.gitignore',
  '.npmrc',
]);
const KNOWN_BASENAME_PATTERN = Array.from(KNOWN_FILE_BASENAMES)
  .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  .join('|');

const normalizePath = (value: string): string => {
  const source = (value || '').trim();
  if (!source) {
    return '';
  }

  const withSlashes = source.replace(/\\/g, '/');
  const hadUncPrefix = withSlashes.startsWith('//');

  let normalized = withSlashes.replace(/\/+/g, '/');
  if (hadUncPrefix && !normalized.startsWith('//')) {
    normalized = `/${normalized}`;
  }

  const isUnixRoot = normalized === '/';
  const isWindowsDriveRoot = /^[A-Za-z]:\/$/.test(normalized);
  if (!isUnixRoot && !isWindowsDriveRoot) {
    normalized = normalized.replace(/\/+$/, '');
  }

  return normalized;
};

const isAbsolutePath = (value: string): boolean => {
  return value.startsWith('/')
    || WINDOWS_DRIVE_PATH_PATTERN.test(value)
    || WINDOWS_UNC_PATH_PATTERN.test(value)
    || value.startsWith('//');
};

const toAbsolutePath = (basePath: string, targetPath: string): string => {
  const normalizedTarget = normalizePath(targetPath);
  if (!normalizedTarget) {
    return normalizePath(basePath);
  }

  if (isAbsolutePath(normalizedTarget)) {
    return normalizedTarget;
  }

  const normalizedBase = normalizePath(basePath);
  if (!normalizedBase) {
    return normalizedTarget;
  }

  const isWindowsDriveBase = /^[A-Za-z]:/.test(normalizedBase);
  const prefix = isWindowsDriveBase ? normalizedBase.slice(0, 2) : '';
  const baseRemainder = isWindowsDriveBase ? normalizedBase.slice(2) : normalizedBase;

  const stack = baseRemainder.split('/').filter(Boolean);
  const parts = normalizedTarget.split('/').filter(Boolean);
  for (const part of parts) {
    if (part === '.') {
      continue;
    }
    if (part === '..') {
      if (stack.length > 0) {
        stack.pop();
      }
      continue;
    }
    stack.push(part);
  }

  if (isWindowsDriveBase) {
    return `${prefix}/${stack.join('/')}`;
  }

  return `/${stack.join('/')}`;
};

const trimPathCandidate = (value: string): string => {
  let next = (value || '').trim();
  if (!next) {
    return '';
  }

  if ((next.startsWith('`') && next.endsWith('`')) || (next.startsWith('"') && next.endsWith('"')) || (next.startsWith("'") && next.endsWith("'"))) {
    next = next.slice(1, -1).trim();
  }

  next = next.replace(/[.,;!?]+$/g, '');

  if (next.endsWith(')') && !next.includes('(')) {
    next = next.slice(0, -1);
  }
  if (next.endsWith(']') && !next.includes('[')) {
    next = next.slice(0, -1);
  }

  return next;
};

const stripTrailingReference = (value: string): string => {
  let next = trimPathCandidate(value);
  if (!next) {
    return '';
  }

  const semicolonIndex = next.indexOf(';');
  if (semicolonIndex >= 0) {
    next = next.slice(0, semicolonIndex);
  }

  next = next.replace(/#.*$/, '');

  const extensionSuffixMatch = next.match(/^(.*\.[A-Za-z0-9_-]{1,16}):.*$/);
  if (extensionSuffixMatch) {
    next = extensionSuffixMatch[1] ?? next;
  }

  const basenameSuffixMatch = KNOWN_BASENAME_PATTERN.length > 0
    ? next.match(new RegExp(`^(.*(?:/|^)(${KNOWN_BASENAME_PATTERN})):.*$`, 'i'))
    : null;
  if (basenameSuffixMatch) {
    next = basenameSuffixMatch[1] ?? next;
  }

  return trimPathCandidate(next);
};

const parseFileReference = (value: string): ParsedFileReference | null => {
  const trimmed = trimPathCandidate(value);
  if (!trimmed) {
    return null;
  }

  const semicolonIndex = trimmed.indexOf(';');
  const withoutSemicolonSuffix = semicolonIndex >= 0
    ? trimPathCandidate(trimmed.slice(0, semicolonIndex))
    : trimmed;
  if (!withoutSemicolonSuffix) {
    return null;
  }

  const hashMatch = withoutSemicolonSuffix.match(/^(.*)#L(\d+)(?:C(\d+))?$/i);
  if (hashMatch) {
    const path = stripTrailingReference(hashMatch[1] ?? '');
    const line = Number.parseInt(hashMatch[2] ?? '', 10);
    const column = hashMatch[3] ? Number.parseInt(hashMatch[3], 10) : undefined;
    if (!path || !Number.isFinite(line)) {
      return null;
    }

    return {
      path,
      line,
      column: Number.isFinite(column ?? Number.NaN) ? column : undefined,
    };
  }

  const colonMatch = withoutSemicolonSuffix.match(/^(.*):(\d+)(?::(\d+))?$/);
  if (colonMatch) {
    const path = stripTrailingReference(colonMatch[1] ?? '');
    const line = Number.parseInt(colonMatch[2] ?? '', 10);
    const column = colonMatch[3] ? Number.parseInt(colonMatch[3], 10) : undefined;
    if (!path || !Number.isFinite(line)) {
      return null;
    }

    return {
      path,
      line,
      column: Number.isFinite(column ?? Number.NaN) ? column : undefined,
    };
  }

  const pathOnly = stripTrailingReference(withoutSemicolonSuffix);
  if (!pathOnly) {
    return null;
  }

  return { path: pathOnly };
};

const hasFileExtension = (path: string): boolean => {
  const base = path.split('/').filter(Boolean).pop() ?? '';
  if (!base || base.endsWith('.')) {
    return false;
  }
  return /\.[A-Za-z0-9_-]{1,16}$/.test(base);
};

const isLikelyFilePathValue = (path: string): boolean => {
  if (!path || path.startsWith('--') || path.includes('://')) {
    return false;
  }

  if (/[<>]/.test(path) || /\s{2,}/.test(path)) {
    return false;
  }

  const normalized = normalizePath(path);
  const baseName = normalized.split('/').filter(Boolean).pop() ?? normalized;
  if (!baseName || baseName === '.' || baseName === '..') {
    return false;
  }

  const base = baseName.toLowerCase();
  if (KNOWN_FILE_BASENAMES.has(base) || (base.startsWith('.') && base.length > 1)) {
    return true;
  }

  return hasFileExtension(normalized);
};

const isLikelyFilePath = (value: string): boolean => {
  const parsed = parseFileReference(value);
  if (!parsed) {
    return false;
  }
  return isLikelyFilePathValue(parsed.path);
};

const extractPathCandidateFromElement = (element: HTMLElement): string => {
  if (element.tagName.toLowerCase() === 'a') {
    const href = element.getAttribute('href')?.trim();
    if (href && isLikelyFilePath(href)) {
      return href;
    }
  }

  return (element.textContent || '').trim();
};

const getResolvedReference = (rawValue: string, effectiveDirectory: string): (ParsedFileReference & { resolvedPath: string }) | null => {
  const parsed = parseFileReference(rawValue);
  if (!parsed || !isLikelyFilePathValue(parsed.path)) {
    return null;
  }

  const resolvedPath = isAbsolutePath(parsed.path)
    ? normalizePath(parsed.path)
    : toAbsolutePath(effectiveDirectory, parsed.path);
  if (!resolvedPath) {
    return null;
  }

  return {
    ...parsed,
    resolvedPath,
  };
};

const getContextDirectory = (effectiveDirectory: string, resolvedPath: string): string => {
  const normalizedDirectory = normalizePath(effectiveDirectory);
  if (normalizedDirectory) {
    return normalizedDirectory;
  }

  const normalizedPath = normalizePath(resolvedPath);
  const parent = normalizedPath.replace(/\/[^/]*$/, '');
  return parent || normalizedPath;
};

const useFileReferenceInteractions = ({
  containerRef,
  effectiveDirectory,
  editor,
  preferRuntimeEditor,
}: {
  containerRef: React.RefObject<HTMLDivElement | null>;
  effectiveDirectory: string;
  editor?: EditorAPI;
  preferRuntimeEditor?: boolean;
}) => {
  const annotationDebounceRef = React.useRef<number | null>(null);

  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const annotateFileLinks = () => {
      const candidates = container.querySelectorAll<HTMLElement>('[data-markdown="inline-code"], a');

      for (const candidate of Array.from(candidates)) {
        const rawCandidate = extractPathCandidateFromElement(candidate);
        const resolved = getResolvedReference(rawCandidate, effectiveDirectory);
        if (!resolved) {
          candidate.removeAttribute('data-openchamber-file-link');
          candidate.removeAttribute('data-openchamber-file-ref');
          candidate.removeAttribute('data-openchamber-file-path');
          if (candidate.getAttribute('title') === 'Open file') {
            candidate.removeAttribute('title');
          }
          if (candidate.tagName.toLowerCase() !== 'a') {
            candidate.removeAttribute('role');
            candidate.removeAttribute('tabindex');
          }
          continue;
        }

        candidate.setAttribute('data-openchamber-file-link', 'true');
        candidate.setAttribute('data-openchamber-file-ref', rawCandidate);
        candidate.setAttribute('data-openchamber-file-path', resolved.resolvedPath);
        candidate.setAttribute('title', 'Open file');
        if (candidate.tagName.toLowerCase() !== 'a') {
          candidate.setAttribute('role', 'button');
          candidate.setAttribute('tabindex', '0');
        }
      }
    };

    const openFileReference = (sourceElement: HTMLElement) => {
      const raw = sourceElement.getAttribute('data-openchamber-file-ref') || extractPathCandidateFromElement(sourceElement);
      const resolved = getResolvedReference(raw, effectiveDirectory);
      if (!resolved) {
        return;
      }

      const contextDirectory = getContextDirectory(effectiveDirectory, resolved.resolvedPath);
      if (preferRuntimeEditor && editor) {
        void editor.openFile(
          resolved.resolvedPath,
          Number.isFinite(resolved.line ?? Number.NaN)
            ? Math.max(1, Math.trunc(resolved.line as number))
            : undefined,
          Number.isFinite(resolved.column ?? Number.NaN)
            ? Math.max(1, Math.trunc(resolved.column as number))
            : undefined,
        );
        return;
      }

      const uiStore = useUIStore.getState();
      if (Number.isFinite(resolved.line ?? Number.NaN)) {
        uiStore.openContextFileAtLine(
          contextDirectory,
          resolved.resolvedPath,
          Math.max(1, Math.trunc(resolved.line as number)),
          Number.isFinite(resolved.column ?? Number.NaN)
            ? Math.max(1, Math.trunc(resolved.column as number))
            : 1,
        );
      } else {
        uiStore.openContextFile(contextDirectory, resolved.resolvedPath);
      }
    };

    const handleClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }

      const fileRefElement = target.closest(FILE_LINK_SELECTOR);
      if (!(fileRefElement instanceof HTMLElement)) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      openFileReference(fileRefElement);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' && event.key !== ' ') {
        return;
      }

      const target = event.target;
      if (!(target instanceof HTMLElement) || target.getAttribute('data-openchamber-file-link') !== 'true') {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      openFileReference(target);
    };

    annotateFileLinks();

    const observer = new MutationObserver(() => {
      if (annotationDebounceRef.current !== null && typeof window !== 'undefined') {
        window.clearTimeout(annotationDebounceRef.current);
      }
      if (typeof window === 'undefined') {
        annotateFileLinks();
        return;
      }
      annotationDebounceRef.current = window.setTimeout(() => {
        annotationDebounceRef.current = null;
        annotateFileLinks();
      }, 120);
    });
    observer.observe(container, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    container.addEventListener('click', handleClick);
    container.addEventListener('keydown', handleKeyDown);

    return () => {
      if (annotationDebounceRef.current !== null && typeof window !== 'undefined') {
        window.clearTimeout(annotationDebounceRef.current);
      }
      annotationDebounceRef.current = null;
      observer.disconnect();
      container.removeEventListener('click', handleClick);
      container.removeEventListener('keydown', handleKeyDown);
    };
  }, [containerRef, editor, effectiveDirectory, preferRuntimeEditor]);
};

const useMermaidInlineInteractions = ({
  containerRef,
  mermaidBlocks,
  onShowPopup,
  allowWheelZoom,
}: {
  containerRef: React.RefObject<HTMLDivElement | null>;
  mermaidBlocks: string[];
  onShowPopup?: (content: ToolPopupContent) => void;
  allowWheelZoom?: boolean;
}) => {
  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const handleMermaidClick = (event: MouseEvent) => {
      if (!onShowPopup) {
        return;
      }

      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }

      if (target.closest('button, a, [role="button"]')) {
        return;
      }

      const block = target.closest(MERMAID_BLOCK_SELECTOR);
      if (!block) {
        return;
      }

      const renderedBlocks = Array.from(container.querySelectorAll(MERMAID_BLOCK_SELECTOR));
      const blockIndex = renderedBlocks.indexOf(block);
      if (blockIndex < 0) {
        return;
      }

      const source = mermaidBlocks[blockIndex];
      if (!source || source.trim().length === 0) {
        return;
      }

      const filename = `Diagram ${blockIndex + 1}`;
      onShowPopup({
        open: true,
        title: filename,
        content: '',
        metadata: {
          tool: 'mermaid-preview',
          filename,
        },
        mermaid: {
          url: `data:text/plain;charset=utf-8,${encodeURIComponent(source)}`,
          source,
          filename,
        },
      });
    };

    const handleInlineWheel = (event: WheelEvent) => {
      if (allowWheelZoom) {
        return;
      }

      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }

      const block = target.closest(MERMAID_BLOCK_SELECTOR);
      if (!block) {
        return;
      }

      // Keep regular page scroll while preventing Streamdown inline wheel-zoom handlers.
      event.stopPropagation();
    };

    container.addEventListener('click', handleMermaidClick);
    container.addEventListener('wheel', handleInlineWheel, { capture: true, passive: true });

    return () => {
      container.removeEventListener('click', handleMermaidClick);
      container.removeEventListener('wheel', handleInlineWheel, true);
    };
  }, [allowWheelZoom, containerRef, mermaidBlocks, onShowPopup]);
};

export const MarkdownRenderer: React.FC<MarkdownRendererProps> = ({
  content,
  part,
  messageId,
  isAnimated = true,
  skipFadeIn = false,
  className,
  isStreaming = false,
  disableStreamAnimation = false,
  variant = 'assistant',
  onShowPopup,
}) => {
  const currentTheme = useCurrentMermaidTheme();
  const { editor, runtime } = useRuntimeAPIs();
  const containerRef = React.useRef<HTMLDivElement>(null);
  const effectiveDirectory = useEffectiveDirectory() ?? '';
  const mermaidBlocks = React.useMemo(() => extractMermaidBlocks(content), [content]);
  useMermaidInlineInteractions({ containerRef, mermaidBlocks, onShowPopup });
  useFileReferenceInteractions({
    containerRef,
    effectiveDirectory,
    editor,
    preferRuntimeEditor: runtime.isVSCode,
  });
  useExternalLinkInteractions({ containerRef });
  const syntaxTheme = React.useMemo(() => generateSyntaxTheme(currentTheme), [currentTheme]);
  const markdownComponents = React.useMemo(() => buildMarkdownComponents({ syntaxTheme }), [syntaxTheme]);
  const componentKey = `markdown-${part?.id ? `part-${part.id}` : `message-${messageId}`}`;
  const markdownBlocks = useStableMarkdownBlocks(content, isStreaming && !disableStreamAnimation, componentKey);

  const markdownClassName = variant === 'tool'
    ? 'markdown-content markdown-tool'
    : variant === 'reasoning'
      ? 'markdown-content markdown-reasoning'
      : 'markdown-content leading-relaxed';

  const markdownContent = (
    <div className={cn('break-words w-full min-w-0', className)} ref={containerRef}>
      <div className={markdownClassName}>
        {markdownBlocks.map((block) => (
          <MarkdownBlockView key={block.key} block={block} components={markdownComponents} />
        ))}
      </div>
    </div>
  );

  if (isAnimated) {
    return (
      <FadeInOnReveal key={componentKey} skipAnimation={skipFadeIn}>
        {markdownContent}
      </FadeInOnReveal>
    );
  }

  return markdownContent;
};

export const SimpleMarkdownRenderer: React.FC<{
  content: string;
  className?: string;
  variant?: MarkdownVariant;
  disableLinkSafety?: boolean;
  stripFrontmatter?: boolean;
  onShowPopup?: (content: ToolPopupContent) => void;
  mermaidControls?: MermaidControlOptions;
  allowMermaidWheelZoom?: boolean;
}> = ({
  content,
  className,
  variant = 'assistant',
  disableLinkSafety,
  stripFrontmatter = false,
  onShowPopup,
  allowMermaidWheelZoom = false,
}) => {
  const { editor, runtime } = useRuntimeAPIs();
  const renderedContent = React.useMemo(
    () => (stripFrontmatter ? stripLeadingFrontmatter(content) : content),
    [content, stripFrontmatter],
  );
  const currentTheme = useCurrentMermaidTheme();
  const containerRef = React.useRef<HTMLDivElement>(null);
  const effectiveDirectory = useEffectiveDirectory() ?? '';
  const mermaidBlocks = React.useMemo(() => extractMermaidBlocks(renderedContent), [renderedContent]);
  useMermaidInlineInteractions({
    containerRef,
    mermaidBlocks,
    onShowPopup,
    allowWheelZoom: allowMermaidWheelZoom,
  });
  useFileReferenceInteractions({
    containerRef,
    effectiveDirectory,
    editor,
    preferRuntimeEditor: runtime.isVSCode,
  });
  useExternalLinkInteractions({ containerRef, enabled: !disableLinkSafety });
  const syntaxTheme = React.useMemo(() => generateSyntaxTheme(currentTheme), [currentTheme]);
  const markdownComponents = React.useMemo(() => buildMarkdownComponents({ syntaxTheme }), [syntaxTheme]);
  const markdownBlocks = useStableMarkdownBlocks(renderedContent, false, `simple:${variant}`);

  const markdownClassName = variant === 'tool'
    ? 'markdown-content markdown-tool'
    : variant === 'reasoning'
      ? 'markdown-content markdown-reasoning'
      : 'markdown-content leading-relaxed';

  return (
    <div className={cn('break-words w-full min-w-0', className)} ref={containerRef}>
      <div className={markdownClassName}>
        {markdownBlocks.map((block) => (
          <MarkdownBlockView key={block.key} block={block} components={markdownComponents} />
        ))}
      </div>
    </div>
  );
};
