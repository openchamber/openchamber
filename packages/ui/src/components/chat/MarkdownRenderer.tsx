import React from 'react';
import { Streamdown } from 'streamdown';
import { code } from '@streamdown/code';
import { mermaid } from '@streamdown/mermaid';
import 'streamdown/styles.css';
import { FadeInOnReveal } from './message/FadeInOnReveal';
import type { Part } from '@opencode-ai/sdk/v2';
import { cn } from '@/lib/utils';
import { RiFileCopyLine, RiCheckLine, RiDownloadLine } from '@remixicon/react';
import { toast } from '@/components/ui';
import { copyTextToClipboard } from '@/lib/clipboard';

import { isVSCodeRuntime } from '@/lib/desktop';
import { useOptionalThemeSystem } from '@/contexts/useThemeSystem';
import { getStreamdownThemePair } from '@/lib/shiki/appThemeRegistry';
import { getDefaultTheme } from '@/lib/theme/themes';
import type { ToolPopupContent } from './message/types';

const withStableStringId = <T extends object>(value: T, id: string): T => {
  const existingPrimitive = (value as Record<symbol, unknown>)[Symbol.toPrimitive];
  if (typeof existingPrimitive === 'function') {
    try {
      if ((existingPrimitive as () => unknown)() === id) {
        return value;
      }
    } catch {
      // Ignore and attempt to define below.
    }
  }

  try {
    Object.defineProperty(value, 'toString', {
      value: () => id,
      enumerable: false,
      configurable: true,
    });
  } catch {
    // Ignore if non-configurable or frozen.
  }

  try {
    Object.defineProperty(value, Symbol.toPrimitive, {
      value: () => id,
      enumerable: false,
      configurable: true,
    });
  } catch {
    // Ignore if non-configurable or frozen.
  }

  return value;
};

const useMarkdownShikiThemes = (): readonly [string | object, string | object] => {
  const themeSystem = useOptionalThemeSystem();

  const isVSCode = isVSCodeRuntime() && typeof window !== 'undefined';

  const fallbackLight = getDefaultTheme(false);
  const fallbackDark = getDefaultTheme(true);

  const lightThemeId = themeSystem?.lightThemeId ?? fallbackLight.metadata.id;
  const darkThemeId = themeSystem?.darkThemeId ?? fallbackDark.metadata.id;

  const lightTheme =
    themeSystem?.availableThemes.find((theme) => theme.metadata.id === lightThemeId) ??
    fallbackLight;
  const darkTheme =
    themeSystem?.availableThemes.find((theme) => theme.metadata.id === darkThemeId) ??
    fallbackDark;

  const fallbackThemes = React.useMemo(
    () => getStreamdownThemePair(lightTheme, darkTheme),
    [darkTheme, lightTheme],
  );

  const getThemes = React.useCallback((): readonly [string | object, string | object] => {
    if (!isVSCode) {
      return fallbackThemes;
    }

    const provided = window.__OPENCHAMBER_VSCODE_SHIKI_THEMES__;
    if (provided?.light && provided?.dark) {
      const light = withStableStringId(
        { ...(provided.light as Record<string, unknown>) },
        `vscode-shiki-light:${String((provided.light as { name?: unknown })?.name ?? 'theme')}`,
      );
      const dark = withStableStringId(
        { ...(provided.dark as Record<string, unknown>) },
        `vscode-shiki-dark:${String((provided.dark as { name?: unknown })?.name ?? 'theme')}`,
      );
      return [light, dark] as const;
    }

    return fallbackThemes;
  }, [fallbackThemes, isVSCode]);

  const [themes, setThemes] = React.useState(getThemes);

  React.useEffect(() => {
    if (!isVSCode) {
      return;
    }

    setThemes(getThemes());
  }, [getThemes, isVSCode]);

  React.useEffect(() => {
    if (!isVSCode) return;

    const handler = (event: Event) => {
      // Rely on the canonical `window.__OPENCHAMBER_VSCODE_SHIKI_THEMES__` that the webview updates
      // before dispatching this event, so we always apply stable cache keys and avoid stale token reuse.
      void event;
      setThemes(getThemes());
    };

    window.addEventListener('openchamber:vscode-shiki-themes', handler as EventListener);
    return () => window.removeEventListener('openchamber:vscode-shiki-themes', handler as EventListener);
  }, [getThemes, isVSCode]);

  return isVSCode ? themes : fallbackThemes;
};

const useStreamdownMermaidOptions = () => {
  const themeSystem = useOptionalThemeSystem();
  const fallbackLight = getDefaultTheme(false);
  const fallbackDark = getDefaultTheme(true);

  const currentTheme = themeSystem?.currentTheme
    ?? (typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches
      ? fallbackDark
      : fallbackLight);

  const MERMAID_CONFIG_VERSION = 'sequence-nowrap-v1';
  const mermaidRenderKey = `${currentTheme.metadata.id}:${currentTheme.metadata.variant}:${themeSystem?.themeMode ?? 'fallback'}:${MERMAID_CONFIG_VERSION}`;

  const options = React.useMemo(() => {
    const isDark = currentTheme.metadata.variant === 'dark';
    return {
      config: {
        theme: isDark ? 'dark' : 'base',
        sequence: {
          useMaxWidth: false,
        },
        themeVariables: {
          primaryColor: currentTheme.colors.surface.elevated,
          primaryTextColor: currentTheme.colors.surface.foreground,
          primaryBorderColor: currentTheme.colors.interactive.border,
          lineColor: currentTheme.colors.interactive.border,
          secondaryColor: currentTheme.colors.surface.muted,
          tertiaryColor: currentTheme.colors.surface.subtle,
          background: currentTheme.colors.surface.background,
          mainBkg: currentTheme.colors.surface.elevated,
          nodeTextColor: currentTheme.colors.surface.foreground,
          edgeLabelBackground: currentTheme.colors.surface.background,
        },
      },
    };
  }, [currentTheme]);

  return React.useMemo(
    () => ({ options, mermaidRenderKey }),
    [mermaidRenderKey, options],
  );
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
        <div className="absolute top-full right-0 z-10 mt-1 min-w-[100px] overflow-hidden rounded-md border border-border bg-background shadow-lg">
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
     
     try {
       const data = extractTableData(tableEl);
       const content = format === 'csv' ? tableToCSV(data) : tableToMarkdown(data);
       const filename = format === 'csv' ? 'table.csv' : 'table.md';
       const mimeType = format === 'csv' ? 'text/csv' : 'text/markdown';
       downloadFile(filename, content, mimeType);
       setShowMenu(false);
       toast.success(`Table downloaded as ${format.toUpperCase()}`);
     } catch (err) {
       console.error('Failed to download table:', err);
     }
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
        <div className="absolute top-full right-0 z-10 mt-1 min-w-[100px] overflow-hidden rounded-md border border-border bg-background shadow-lg">
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
    <div className="group my-4 flex flex-col space-y-2" data-streamdown="table-wrapper" ref={tableRef}>
      <div className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <TableCopyButton tableRef={tableRef} />
        <TableDownloadButton tableRef={tableRef} />
      </div>
      <div className="overflow-x-auto">
        <table className={cn('w-full border-collapse border border-border', className)} data-streamdown="table">
          {children}
        </table>
      </div>
    </div>
  );
};

type CodeBlockWrapperProps = React.HTMLAttributes<HTMLPreElement> & {
  children?: React.ReactNode;
};

const getMermaidInfo = (children: React.ReactNode): { isMermaid: boolean; source: string } => {
  if (!React.isValidElement(children)) return { isMermaid: false, source: '' };
  const props = children.props as Record<string, unknown> | undefined;
  const className = typeof props?.className === 'string' ? props.className : '';
  if (!className.includes('language-mermaid')) return { isMermaid: false, source: '' };
  // Extract raw mermaid source from the code element's children
  const codeChildren = props?.children;
  let source = '';
  if (typeof codeChildren === 'string') {
    source = codeChildren;
  } else if (React.isValidElement(codeChildren)) {
    const innerProps = codeChildren.props as Record<string, unknown> | undefined;
    if (typeof innerProps?.children === 'string') source = innerProps.children;
  }
  return { isMermaid: true, source };
};

const CodeBlockWrapper: React.FC<CodeBlockWrapperProps> = ({ children, className, style, ...props }) => {
  const [copied, setCopied] = React.useState(false);
  const codeRef = React.useRef<HTMLDivElement>(null);
  const mermaidInfo = getMermaidInfo(children);
  const codeChild = React.useMemo(
    () => (
      React.isValidElement(children)
        ? React.cloneElement(children as React.ReactElement<Record<string, unknown>>, { 'data-block': true })
        : children
    ),
    [children],
  );

  const normalizedStyle = React.useMemo<React.CSSProperties | undefined>(() => {
    if (!style) return style;

    const next: React.CSSProperties = { ...style };

    const normalizeDeclarationString = (
      raw: unknown
    ): { value?: string; vars: Record<string, string> } => {
      if (typeof raw !== 'string') return { value: undefined, vars: {} };

      const [valuePart, ...rest] = raw.split(';').map((p) => p.trim()).filter(Boolean);
      const vars: Record<string, string> = {};
      for (const decl of rest) {
        const idx = decl.indexOf(':');
        if (idx === -1) continue;
        const prop = decl.slice(0, idx).trim();
        const value = decl.slice(idx + 1).trim();
        if (!prop.startsWith('--') || value.length === 0) continue;
        vars[prop] = value;
      }
      return { value: valuePart, vars };
    };

    const bg = normalizeDeclarationString((style as React.CSSProperties).backgroundColor);
    if (bg.value) {
      next.backgroundColor = bg.value;
      (next as Record<string, string>)['--shiki-light-bg'] = bg.value;
    }
    for (const [k, v] of Object.entries(bg.vars)) {
      (next as Record<string, string>)[k] = v;
    }

    const fg = normalizeDeclarationString((style as React.CSSProperties).color);
    if (fg.value) {
      next.color = fg.value;
      (next as Record<string, string>)['--shiki-light'] = fg.value;
    }
    for (const [k, v] of Object.entries(fg.vars)) {
      (next as Record<string, string>)[k] = v;
    }

    return next;
  }, [style]);

  // Mermaid blocks are handled by Streamdown Mermaid controls.
  if (mermaidInfo.isMermaid) {
    return codeChild;
  }

  const getCodeContent = (): string => {
    if (!codeRef.current) return '';
    const codeEl = codeRef.current.querySelector('code');

    return codeEl?.innerText || '';
  };

  const handleCopy = async () => {
    const code = getCodeContent();
    if (!code) return;
    const result = await copyTextToClipboard(code);
    if (result.ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } else {
      console.error('Failed to copy:', result.error);
    }
  };

  return (
    <div className="group relative" ref={codeRef}>
      <pre
        {...props}
        className={cn(className)}
        style={normalizedStyle}
      >
        {codeChild}
      </pre>
      <div className="absolute top-1 right-2 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          onClick={handleCopy}
          className="p-1 rounded hover:bg-interactive-hover/60 text-muted-foreground hover:text-foreground transition-colors"
          title="Copy"
        >
          {copied ? <RiCheckLine className="size-3.5" /> : <RiFileCopyLine className="size-3.5" />}
        </button>
      </div>
    </div>
  );
};

const streamdownComponents = {
  pre: CodeBlockWrapper,
  table: TableWrapper,
};

const streamdownPlugins = {
  code,
  mermaid,
};

const streamdownControls = {
  code: false,
  table: false,
  mermaid: {
    download: true,
    copy: true,
    fullscreen: false,
    panZoom: false,
  },
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

export type MarkdownVariant = 'assistant' | 'tool';

interface MarkdownRendererProps {
  content: string;
  part?: Part;
  messageId: string;
  isAnimated?: boolean;
  className?: string;
  isStreaming?: boolean;
  variant?: MarkdownVariant;
  onShowPopup?: (content: ToolPopupContent) => void;
}

const MERMAID_BLOCK_SELECTOR = '[data-streamdown="mermaid-block"]';

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
  className,
  isStreaming = false,
  variant = 'assistant',
  onShowPopup,
}) => {
  const streamdownContainerRef = React.useRef<HTMLDivElement>(null);
  const mermaidBlocks = React.useMemo(() => extractMermaidBlocks(content), [content]);
  useMermaidInlineInteractions({ containerRef: streamdownContainerRef, mermaidBlocks, onShowPopup });

  const shikiThemes = useMarkdownShikiThemes();
  const { options: mermaidOptions, mermaidRenderKey } = useStreamdownMermaidOptions();
  const componentKey = React.useMemo(() => {
    const signature = part?.id ? `part-${part.id}` : `message-${messageId}`;
    return `markdown-${signature}`;
  }, [messageId, part?.id]);

  const streamdownClassName = variant === 'tool'
    ? 'streamdown-content streamdown-tool'
    : 'streamdown-content';

  const markdownContent = (
    <div className={cn('break-words', className)} ref={streamdownContainerRef}>
      <Streamdown
         key={`streamdown-${componentKey}-${mermaidRenderKey}`}
         mode={isStreaming ? 'streaming' : 'static'}
         shikiTheme={shikiThemes}
         className={streamdownClassName}
         controls={streamdownControls}
         plugins={streamdownPlugins}
         mermaid={mermaidOptions}
         components={streamdownComponents}
       >
        {content}
      </Streamdown>
    </div>
  );

  if (isAnimated) {
    return (
      <FadeInOnReveal key={componentKey}>
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
  onShowPopup?: (content: ToolPopupContent) => void;
  mermaidControls?: MermaidControlOptions;
  allowMermaidWheelZoom?: boolean;
}> = ({ content, className, variant = 'assistant', disableLinkSafety, onShowPopup, mermaidControls, allowMermaidWheelZoom = false }) => {
  const streamdownContainerRef = React.useRef<HTMLDivElement>(null);
  const mermaidBlocks = React.useMemo(() => extractMermaidBlocks(content), [content]);
  useMermaidInlineInteractions({
    containerRef: streamdownContainerRef,
    mermaidBlocks,
    onShowPopup,
    allowWheelZoom: allowMermaidWheelZoom,
  });

  const shikiThemes = useMarkdownShikiThemes();
  const { options: mermaidOptions, mermaidRenderKey } = useStreamdownMermaidOptions();

  const streamdownClassName = variant === 'tool'
    ? 'streamdown-content streamdown-tool'
    : 'streamdown-content';

  return (
    <div className={cn('break-words', className)} ref={streamdownContainerRef}>
      <Streamdown
        key={`streamdown-simple-${mermaidRenderKey}`}
        mode="static"
        shikiTheme={shikiThemes}
        className={streamdownClassName}
        controls={{
          ...streamdownControls,
          mermaid: mermaidControls ?? streamdownControls.mermaid,
        }}
        plugins={streamdownPlugins}
        mermaid={mermaidOptions}
        components={streamdownComponents}
        // @ts-expect-error Streamdown type missing linkSafety in older minor
        linkSafety={disableLinkSafety ? { enabled: false } : undefined}
      >
        {content}
      </Streamdown>
    </div>
  );
};
