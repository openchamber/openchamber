import React from 'react';
import { Streamdown } from 'streamdown';
import { createCodePlugin } from '@streamdown/code';
import { renderMermaidASCII, renderMermaidSVG } from 'beautiful-mermaid';
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
import { useUIStore } from '@/stores/useUIStore';
import { useDeviceInfo } from '@/lib/device';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type { EditorAPI } from '@/lib/api/types';

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

type StreamdownCodeThemes = NonNullable<Parameters<typeof createCodePlugin>[0]>['themes'];

const useStreamdownPlugins = (shikiThemes: readonly [string | object, string | object]) => {
  return React.useMemo(
    () => ({
      code: createCodePlugin({
        // Streamdown code plugin runtime accepts theme objects, but current type only models bundled theme names.
        themes: shikiThemes as unknown as StreamdownCodeThemes,
      }),
    }),
    [shikiThemes],
  );
};

const useCurrentMermaidTheme = () => {
  const themeSystem = useOptionalThemeSystem();
  const fallbackLight = getDefaultTheme(false);
  const fallbackDark = getDefaultTheme(true);

  return themeSystem?.currentTheme
    ?? (typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches
      ? fallbackDark
      : fallbackLight);
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
      <div data-streamdown="mermaid-block" className="group">
        <div data-streamdown="mermaid-scroll">
          <pre data-streamdown="mermaid-ascii">{asciiText}</pre>
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
      <div data-streamdown="mermaid-block" className="group">
        <div data-streamdown="mermaid-scroll">
          <pre data-streamdown="mermaid-ascii">{source}</pre>
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
    <div data-streamdown="mermaid-block" className="group">
      <div data-streamdown="mermaid-scroll">
        <div data-streamdown="mermaid" dangerouslySetInnerHTML={{ __html: svg }} />
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

const CodeBlockWrapper: React.FC<CodeBlockWrapperProps> = ({ children, className, style, ...props }) => {
  const mermaidInfo = getMermaidInfo(children);
  const mermaidRenderingMode = useUIStore((state) => state.mermaidRenderingMode);
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
    }
    for (const [k, v] of Object.entries(bg.vars)) {
      (next as Record<string, string>)[k] = v;
    }

    const fg = normalizeDeclarationString((style as React.CSSProperties).color);
    if (fg.value) {
      next.color = fg.value;
    }
    for (const [k, v] of Object.entries(fg.vars)) {
      (next as Record<string, string>)[k] = v;
    }

    return next;
  }, [style]);

  if (mermaidInfo.isMermaid) {
    return <MermaidBlock source={mermaidInfo.source} mode={mermaidRenderingMode} />;
  }

  return (
    <pre
      {...props}
      className={cn(className, 'w-full min-w-full')}
      style={normalizedStyle}
    >
      {codeChild}
    </pre>
  );
};

const streamdownComponents = {
  pre: CodeBlockWrapper,
  table: TableWrapper,
};

const streamdownControls = {
  code: true,
  table: false,
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

const MERMAID_BLOCK_SELECTOR = '[data-streamdown="mermaid-block"]';
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
  readFile,
  editor,
  preferRuntimeEditor,
}: {
  containerRef: React.RefObject<HTMLDivElement | null>;
  effectiveDirectory: string;
  readFile?: (path: string) => Promise<{ content: string; path: string }>;
  editor?: EditorAPI;
  preferRuntimeEditor?: boolean;
}) => {
  const validationCacheRef = React.useRef<Map<string, boolean>>(new Map());
  const inFlightValidationsRef = React.useRef<Map<string, Promise<boolean>>>(new Map());
  const annotationPassRef = React.useRef(0);
  const annotationDebounceRef = React.useRef<number | null>(null);
  const isValidationSweepRunningRef = React.useRef(false);

  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    let disposed = false;

    const isPathResolvable = async (resolvedPath: string): Promise<boolean> => {
      const cache = validationCacheRef.current;
      if (cache.has(resolvedPath)) {
        return cache.get(resolvedPath) === true;
      }

      const inFlight = inFlightValidationsRef.current.get(resolvedPath);
      if (inFlight) {
        return inFlight;
      }

      const checkPromise = (async () => {
        try {
          if (!readFile) {
            return false;
          }
          await readFile(resolvedPath);
          cache.set(resolvedPath, true);
          return true;
        } catch {
          cache.set(resolvedPath, false);
          return false;
        } finally {
          inFlightValidationsRef.current.delete(resolvedPath);
        }
      })();

      inFlightValidationsRef.current.set(resolvedPath, checkPromise);
      return checkPromise;
    };

    const clearCandidateLinkAttrs = (candidate: HTMLElement) => {
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
    };

    const applyCandidateLinkAttrs = (candidate: HTMLElement, rawCandidate: string, resolvedPath: string) => {
      candidate.setAttribute('data-openchamber-file-link', 'true');
      candidate.setAttribute('data-openchamber-file-ref', rawCandidate);
      candidate.setAttribute('data-openchamber-file-path', resolvedPath);
      candidate.setAttribute('title', 'Open file');
      if (candidate.tagName.toLowerCase() !== 'a') {
        candidate.setAttribute('role', 'button');
        candidate.setAttribute('tabindex', '0');
      }
    };

    const runValidationSweep = async (paths: string[], expectedPassID: number) => {
      if (isValidationSweepRunningRef.current || paths.length === 0) {
        return;
      }

      isValidationSweepRunningRef.current = true;
      const maxConcurrent = 3;
      let cursor = 0;

      const worker = async () => {
        while (!disposed && cursor < paths.length) {
          const index = cursor;
          cursor += 1;
          const pathToCheck = paths[index];
          if (!pathToCheck) {
            continue;
          }
          await isPathResolvable(pathToCheck);
        }
      };

      try {
        await Promise.all(Array.from({ length: Math.min(maxConcurrent, paths.length) }, () => worker()));
      } finally {
        isValidationSweepRunningRef.current = false;
      }

      if (!disposed && annotationPassRef.current === expectedPassID) {
        void annotateFileLinks();
      }
    };

    const annotateFileLinks = async () => {
      const passID = annotationPassRef.current + 1;
      annotationPassRef.current = passID;
      const candidates = container.querySelectorAll<HTMLElement>('[data-streamdown="inline-code"], a');
      const unresolvedPaths = new Set<string>();

      for (const candidate of Array.from(candidates)) {
        const rawCandidate = extractPathCandidateFromElement(candidate);
        const resolved = getResolvedReference(rawCandidate, effectiveDirectory);
        if (!resolved) {
          clearCandidateLinkAttrs(candidate);
          continue;
        }

        if (annotationPassRef.current !== passID) {
          return;
        }

        const cachedResult = validationCacheRef.current.get(resolved.resolvedPath);
        if (cachedResult === true) {
          applyCandidateLinkAttrs(candidate, rawCandidate, resolved.resolvedPath);
          continue;
        }

        clearCandidateLinkAttrs(candidate);
        if (cachedResult !== false) {
          unresolvedPaths.add(resolved.resolvedPath);
        }
      }

      if (unresolvedPaths.size > 0) {
        void runValidationSweep(Array.from(unresolvedPaths), passID);
      }
    };

    const openFileReference = async (sourceElement: HTMLElement): Promise<boolean> => {
      const raw = sourceElement.getAttribute('data-openchamber-file-ref') || extractPathCandidateFromElement(sourceElement);
      const resolved = getResolvedReference(raw, effectiveDirectory);
      if (!resolved) {
        return false;
      }

      const isResolvable = await isPathResolvable(resolved.resolvedPath);
      if (!isResolvable) {
        sourceElement.removeAttribute('data-openchamber-file-link');
        sourceElement.removeAttribute('data-openchamber-file-ref');
        sourceElement.removeAttribute('data-openchamber-file-path');
        if (sourceElement.getAttribute('title') === 'Open file') {
          sourceElement.removeAttribute('title');
        }
        return false;
      }

      const contextDirectory = getContextDirectory(effectiveDirectory, resolved.resolvedPath);
      if (preferRuntimeEditor && editor) {
        await editor.openFile(
          resolved.resolvedPath,
          Number.isFinite(resolved.line ?? Number.NaN)
            ? Math.max(1, Math.trunc(resolved.line as number))
            : undefined,
          Number.isFinite(resolved.column ?? Number.NaN)
            ? Math.max(1, Math.trunc(resolved.column as number))
            : undefined,
        );
        return true;
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
      return true;
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

      void openFileReference(fileRefElement);
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

      void openFileReference(target);
    };

    void annotateFileLinks();

    const observer = new MutationObserver(() => {
      if (annotationDebounceRef.current !== null && typeof window !== 'undefined') {
        window.clearTimeout(annotationDebounceRef.current);
      }
      if (typeof window === 'undefined') {
        void annotateFileLinks();
        return;
      }
      annotationDebounceRef.current = window.setTimeout(() => {
        annotationDebounceRef.current = null;
        void annotateFileLinks();
      }, 120);
    });
    observer.observe(container, { childList: true, subtree: true, characterData: true });

    container.addEventListener('click', handleClick);
    container.addEventListener('keydown', handleKeyDown);

    return () => {
      disposed = true;
      annotationPassRef.current += 1;
      if (annotationDebounceRef.current !== null && typeof window !== 'undefined') {
        window.clearTimeout(annotationDebounceRef.current);
      }
      annotationDebounceRef.current = null;
      observer.disconnect();
      container.removeEventListener('click', handleClick);
      container.removeEventListener('keydown', handleKeyDown);
    };
  }, [containerRef, editor, effectiveDirectory, preferRuntimeEditor, readFile]);
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
  const { files, editor, runtime } = useRuntimeAPIs();
  const streamdownContainerRef = React.useRef<HTMLDivElement>(null);
  const effectiveDirectory = useEffectiveDirectory() ?? '';
  const mermaidBlocks = React.useMemo(() => extractMermaidBlocks(content), [content]);
  useMermaidInlineInteractions({ containerRef: streamdownContainerRef, mermaidBlocks, onShowPopup });
  useFileReferenceInteractions({
    containerRef: streamdownContainerRef,
    effectiveDirectory,
    readFile: files.readFile,
    editor,
    preferRuntimeEditor: runtime.isVSCode,
  });

  const shikiThemes = useMarkdownShikiThemes();
  const streamdownPlugins = useStreamdownPlugins(shikiThemes);
  const currentMermaidTheme = useCurrentMermaidTheme();
  const componentKey = `markdown-${part?.id ? `part-${part.id}` : `message-${messageId}`}`;

  const streamdownClassName = variant === 'tool'
    ? 'streamdown-content streamdown-tool'
    : variant === 'reasoning'
      ? 'streamdown-content streamdown-reasoning'
      : 'streamdown-content';

  const streamdownAnimated = React.useMemo(
    () => ({ animation: 'blurIn' as const, duration: 150, easing: 'ease-out' }),
    [],
  );

  const markdownContent = (
    <div className={cn('break-words w-full min-w-0', className)} ref={streamdownContainerRef}>
        <Streamdown
         key={`streamdown-${componentKey}-${currentMermaidTheme.metadata.id}:${currentMermaidTheme.metadata.variant}`}
         mode={isStreaming && !disableStreamAnimation ? 'streaming' : 'static'}
         shikiTheme={shikiThemes}
         className={streamdownClassName}
         controls={streamdownControls}
         plugins={streamdownPlugins}
         components={streamdownComponents}
         animated={disableStreamAnimation ? undefined : streamdownAnimated}
         isAnimating={disableStreamAnimation ? false : isStreaming}
        >
        {content}
      </Streamdown>
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
  const { files, editor, runtime } = useRuntimeAPIs();
  const renderedContent = React.useMemo(
    () => (stripFrontmatter ? stripLeadingFrontmatter(content) : content),
    [content, stripFrontmatter],
  );
  const streamdownContainerRef = React.useRef<HTMLDivElement>(null);
  const effectiveDirectory = useEffectiveDirectory() ?? '';
  const mermaidBlocks = React.useMemo(() => extractMermaidBlocks(renderedContent), [renderedContent]);
  useMermaidInlineInteractions({
    containerRef: streamdownContainerRef,
    mermaidBlocks,
    onShowPopup,
    allowWheelZoom: allowMermaidWheelZoom,
  });
  useFileReferenceInteractions({
    containerRef: streamdownContainerRef,
    effectiveDirectory,
    readFile: files.readFile,
    editor,
    preferRuntimeEditor: runtime.isVSCode,
  });

  const shikiThemes = useMarkdownShikiThemes();
  const streamdownPlugins = useStreamdownPlugins(shikiThemes);
  const currentMermaidTheme = useCurrentMermaidTheme();

  const streamdownClassName = variant === 'tool'
    ? 'streamdown-content streamdown-tool'
    : variant === 'reasoning'
      ? 'streamdown-content streamdown-reasoning'
      : 'streamdown-content';

  return (
    <div className={cn('break-words w-full min-w-0', className)} ref={streamdownContainerRef}>
      <Streamdown
        key={`streamdown-simple-${currentMermaidTheme.metadata.id}:${currentMermaidTheme.metadata.variant}`}
        mode="static"
        shikiTheme={shikiThemes}
        className={streamdownClassName}
        controls={streamdownControls}
        plugins={streamdownPlugins}
        components={streamdownComponents}
        // @ts-expect-error Streamdown type missing linkSafety in older minor
        linkSafety={disableLinkSafety ? { enabled: false } : undefined}
      >
        {renderedContent}
      </Streamdown>
    </div>
  );
};
