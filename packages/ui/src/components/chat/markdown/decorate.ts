import { copyTextToClipboard } from '@/lib/clipboard';
import { getExternalFaviconUrl, isExternalHttpUrl, isLoopbackHttpUrl } from '@/lib/url';
import type { IconName } from '@/components/icon/icons';
import { getMermaidViewerController } from './mermaidViewer';

// ---------------------------------------------------------------------------
// Shared decoration context
// ---------------------------------------------------------------------------

export type MermaidRender = { svg?: string; ascii?: string };

export type DecorateLabels = {
  copy: string;
  copied: string;
  enableCodeWrap: string;
  disableCodeWrap: string;
  copyDiagram: string;
  downloadDiagram: string;
  zoomInDiagram: string;
  zoomOutDiagram: string;
  resetDiagramView: string;
  previewLabel: string;
  previewTitle: string;
};

export type MermaidControlOptions = {
  download: boolean;
  copy: boolean;
  showPanZoomControls: boolean;
};

export type DecorateContext = {
  labels: DecorateLabels;
  mermaidControls: MermaidControlOptions;
  codeBlockLineWrap: boolean;
  deferCodeLineNumberSync?: boolean;
  onToggleCodeBlockLineWrap?: () => void;
  // Renders a mermaid block source to svg/ascii using current theme colors.
  renderMermaid: (source: string) => MermaidRender;
  onPreviewLoopback?: (url: string) => void;
};

// Reference the app's icon sprite (injected into <body> by the shared Icon
// component) so DOM-built controls use the same themed icons as the rest of
// the app. Sprite symbols are registered under `#oc-<name>`.
const spriteIcon = (name: IconName): string =>
  `<svg class="oc-icon size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><use href="#oc-${name}"></use></svg>`;

const ICONS = {
  copy: spriteIcon('file-copy'),
  check: spriteIcon('check'),
  download: spriteIcon('download'),
  zoomIn: spriteIcon('add'),
  zoomOut: spriteIcon('subtract'),
  fit: spriteIcon('refresh'),
  textWrap: spriteIcon('text-wrap'),
} as const;

const ICON_BTN_CLASS =
  'p-1 rounded hover:bg-interactive-hover/60 text-muted-foreground hover:text-foreground transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--interactive-focus-ring)]';

const setIconHtml = (el: Element, html: string): void => {
  el.innerHTML = html;
};

const makeIconButton = (icon: keyof typeof ICONS, title: string, slot: string): HTMLButtonElement => {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = ICON_BTN_CLASS;
  button.setAttribute('data-md-action', slot);
  button.setAttribute('title', title);
  button.setAttribute('aria-label', title);
  setIconHtml(button, ICONS[icon]);
  return button;
};

const applyCodeBlockWrapState = (wrapper: HTMLElement, enabled: boolean, labels: DecorateLabels): void => {
  const body = wrapper.querySelector<HTMLElement>('[data-md-code-body]');
  const pre = wrapper.querySelector<HTMLElement>('pre');
  const code = wrapper.querySelector<HTMLElement>('pre code');
  const wrapButton = wrapper.querySelector<HTMLButtonElement>('[data-md-action="toggle-code-wrap"]');
  wrapper.setAttribute('data-code-wrap', enabled ? 'true' : 'false');
  body?.classList.toggle('overflow-x-auto', !enabled);
  body?.classList.toggle('overflow-x-hidden', enabled);
  pre?.classList.toggle('whitespace-pre-wrap', enabled);
  pre?.classList.toggle('break-words', enabled);
  code?.classList.toggle('whitespace-pre-wrap', enabled);
  code?.classList.toggle('break-words', enabled);
  if (pre) {
    pre.style.whiteSpace = enabled ? 'pre-wrap' : 'pre';
    pre.style.overflowWrap = enabled ? 'anywhere' : 'normal';
  }
  if (code) {
    code.style.whiteSpace = enabled ? 'pre-wrap' : 'pre';
    code.style.overflowWrap = enabled ? 'anywhere' : 'normal';
  }
  if (wrapButton) {
    const title = enabled ? labels.disableCodeWrap : labels.enableCodeWrap;
    wrapButton.setAttribute('title', title);
    wrapButton.setAttribute('aria-label', title);
    wrapButton.classList.toggle('text-foreground', enabled);
    wrapButton.classList.toggle('opacity-100', enabled);
    wrapButton.classList.toggle('text-muted-foreground', !enabled);
    wrapButton.classList.toggle('opacity-65', !enabled);
    wrapButton.setAttribute('aria-pressed', enabled ? 'true' : 'false');
  }
};

const createCodeLineNumbers = (pre: HTMLPreElement): HTMLDivElement => {
  const gutter = document.createElement('div');
  gutter.setAttribute('data-md-code-line-numbers', '');
  gutter.setAttribute('aria-hidden', 'true');
  gutter.className = 'min-w-8 shrink-0 select-none border-r border-border/50 pr-3 text-right font-mono text-[13px] text-muted-foreground/45';

  const text = pre.textContent ?? '';
  const lineCount = Math.max(1, text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length);
  for (let index = 1; index <= lineCount; index += 1) {
    const line = document.createElement('div');
    line.className = 'tabular-nums';
    line.textContent = String(index);
    gutter.appendChild(line);
  }

  return gutter;
};

const collectTextNodes = (root: HTMLElement): Text[] => {
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    nodes.push(node as Text);
    node = walker.nextNode();
  }
  return nodes;
};

const findTextPosition = (nodes: Text[], targetOffset: number): { node: Text; offset: number } | null => {
  let offset = 0;
  for (const node of nodes) {
    const nextOffset = offset + node.data.length;
    if (targetOffset <= nextOffset) {
      return { node, offset: Math.max(0, targetOffset - offset) };
    }
    offset = nextOffset;
  }
  const last = nodes.at(-1);
  return last ? { node: last, offset: last.data.length } : null;
};

export const syncMarkdownCodeLineNumbers = (root: HTMLElement): void => {
  const wrappers = root.querySelectorAll<HTMLElement>('[data-component="markdown-code"]');
  for (const wrapper of Array.from(wrappers)) {
    const code = wrapper.querySelector<HTMLElement>('pre code');
    const gutter = wrapper.querySelector<HTMLElement>('[data-md-code-line-numbers]');
    if (!code || !gutter) continue;

    const numbers = Array.from(gutter.children) as HTMLElement[];
    const text = code.textContent ?? '';
    const textNodes = collectTextNodes(code);
    const codeStyle = window.getComputedStyle(code);
    const lineHeight = Number.parseFloat(codeStyle.lineHeight) || 20;
    gutter.style.fontFamily = codeStyle.fontFamily;
    gutter.style.fontSize = codeStyle.fontSize;
    gutter.style.lineHeight = `${lineHeight}px`;
    let lineStart = 0;

    for (let index = 0; index < numbers.length; index += 1) {
      const nextBreak = text.indexOf('\n', lineStart);
      const lineEnd = nextBreak === -1 ? text.length : nextBreak;
      const lineEl = numbers[index];
      if (!lineEl) continue;

      const start = findTextPosition(textNodes, lineStart);
      const end = findTextPosition(textNodes, lineEnd);
      if (!start || !end || lineStart === lineEnd) {
        lineEl.style.height = `${lineHeight}px`;
        lineEl.style.lineHeight = `${lineHeight}px`;
      } else {
        const range = document.createRange();
        range.setStart(start.node, start.offset);
        range.setEnd(end.node, end.offset);
        const rowTops: number[] = [];
        for (const rect of Array.from(range.getClientRects())) {
          if (rect.width === 0 && rect.height === 0) continue;
          if (!rowTops.some((top) => Math.abs(top - rect.top) < 2)) {
            rowTops.push(rect.top);
          }
        }
        const height = Math.max(lineHeight, Math.max(1, rowTops.length) * lineHeight);
        range.detach();
        lineEl.style.height = `${height}px`;
        lineEl.style.lineHeight = `${lineHeight}px`;
      }

      lineStart = lineEnd + 1;
    }
  }
};

export const scheduleMarkdownCodeLineNumberSync = (root: HTMLElement): void => {
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => syncMarkdownCodeLineNumbers(root));
  });
};

export const applyMarkdownCodeBlockWrapState = (root: HTMLElement, enabled: boolean, labels: DecorateLabels): void => {
  const wrappers = root.querySelectorAll<HTMLElement>('[data-component="markdown-code"]');
  for (const wrapper of Array.from(wrappers)) {
    const body = wrapper.querySelector<HTMLElement>('[data-md-code-body]');
    const pre = wrapper.querySelector<HTMLPreElement>('pre');
    if (body && pre && !body.querySelector('[data-md-code-line-numbers]')) {
      body.classList.add('flex', 'gap-3');
      body.insertBefore(createCodeLineNumbers(pre), pre);
    }
    applyCodeBlockWrapState(wrapper, enabled, labels);
  }
  scheduleMarkdownCodeLineNumberSync(root);
};

const flashCopied = (button: HTMLButtonElement, copiedTitle: string, restore: keyof typeof ICONS, restoreTitle: string): void => {
  setIconHtml(button, ICONS.check);
  button.setAttribute('title', copiedTitle);
  button.setAttribute('aria-label', copiedTitle);
  window.setTimeout(() => {
    setIconHtml(button, ICONS[restore]);
    button.setAttribute('title', restoreTitle);
    button.setAttribute('aria-label', restoreTitle);
  }, 2000);
};

// ---------------------------------------------------------------------------
// Code blocks: inline-code marker + copy button wrapper
// ---------------------------------------------------------------------------

const decorateInlineCode = (root: HTMLElement): void => {
  const inline = root.querySelectorAll<HTMLElement>(':not(pre) > code');
  for (const code of Array.from(inline)) {
    if (code.getAttribute('data-markdown') !== 'inline-code') {
      code.setAttribute('data-markdown', 'inline-code');
    }
  }
};

const decorateCodeBlocks = (root: HTMLElement, ctx: DecorateContext): void => {
  const blocks = root.querySelectorAll<HTMLPreElement>('pre');
  for (const pre of Array.from(blocks)) {
    // Skip mermaid placeholders (handled separately).
    if (pre.querySelector('code.language-mermaid')) continue;
    const parent = pre.parentElement;
    if (!parent) continue;
    // Already wrapped (idempotent across morphdom passes).
    if (parent.closest('[data-component="markdown-code"]')) continue;

    // `data-md-lang` is stamped by the async highlight pass; on the synchronous
    // first paint it isn't set yet, so fall back to the `language-*` class marked
    // emits — keeps the card header label stable instead of flashing 'text'.
    const classLang = pre.querySelector('code')?.className.match(/language-([\w+#.-]+)/)?.[1];
    const language = pre.getAttribute('data-md-lang') ?? classLang ?? 'text';

    const wrapper = document.createElement('div');
    wrapper.setAttribute('data-component', 'markdown-code');
    wrapper.className =
      'my-4 group overflow-hidden rounded-2xl border border-border/80 bg-[var(--surface-elevated)]';

    const header = document.createElement('div');
    header.className = 'flex items-center justify-between border-b border-border/70 px-3 py-1.5';
    const langLabel = document.createElement('span');
    langLabel.className = 'font-mono text-[13px] text-muted-foreground';
    langLabel.textContent = language;
    const copyBtn = makeIconButton('copy', ctx.labels.copy, 'copy-code');
    const wrapBtn = makeIconButton('textWrap', ctx.codeBlockLineWrap ? ctx.labels.disableCodeWrap : ctx.labels.enableCodeWrap, 'toggle-code-wrap');
    header.appendChild(langLabel);
    const actions = document.createElement('div');
    actions.className = 'flex items-center gap-1';
    actions.appendChild(wrapBtn);
    actions.appendChild(copyBtn);
    header.appendChild(actions);

    const body = document.createElement('div');
    body.setAttribute('data-md-code-body', '');
    body.className = ctx.deferCodeLineNumberSync ? 'px-3 py-2.5 overflow-x-auto' : 'flex gap-3 px-3 py-2.5 overflow-x-auto';

    parent.replaceChild(wrapper, pre);
    pre.style.margin = '0';
    pre.style.background = 'transparent';
    pre.classList.add('min-w-0', 'w-full', 'flex-1');
    if (!ctx.deferCodeLineNumberSync) {
      body.appendChild(createCodeLineNumbers(pre));
    }
    body.appendChild(pre);
    wrapper.appendChild(header);
    wrapper.appendChild(body);
    applyCodeBlockWrapState(wrapper, ctx.codeBlockLineWrap, ctx.labels);
    if (!ctx.deferCodeLineNumberSync) {
      scheduleMarkdownCodeLineNumberSync(wrapper);
    }
  }
};

// ---------------------------------------------------------------------------
// Tables: wrapper + horizontal scrolling
// ---------------------------------------------------------------------------
const decorateTables = (root: HTMLElement): void => {
  const tables = root.querySelectorAll<HTMLTableElement>('table');
  for (const table of Array.from(tables)) {
    const existing = table.closest('[data-markdown="table-wrapper"]');
    if (existing) continue;

    const wrapper = document.createElement('div');
    wrapper.className = 'my-4';
    wrapper.setAttribute('data-markdown', 'table-wrapper');

    const scroll = document.createElement('div');
    scroll.className = 'overflow-x-auto rounded-lg border border-border/80 bg-[var(--surface-elevated)]';

    const parent = table.parentElement;
    if (!parent) continue;
    parent.replaceChild(wrapper, table);
    table.setAttribute('data-markdown', 'table');
    table.classList.add('w-full', 'border-collapse', 'text-sm');

    for (const tr of Array.from(table.querySelectorAll('tr'))) {
      tr.classList.add('border-b', 'border-border/60');
    }
    const lastBodyRow = table.querySelector('tbody tr:last-child');
    lastBodyRow?.classList.remove('border-b');
    lastBodyRow?.classList.add('border-0');
    for (const th of Array.from(table.querySelectorAll('th'))) {
      th.classList.add('border-r', 'border-border/60', 'px-4', 'py-2.5', 'text-left', 'align-middle', 'font-semibold', 'text-foreground', 'last:border-r-0');
    }
    for (const td of Array.from(table.querySelectorAll('td'))) {
      td.classList.add('border-r', 'border-border/60', 'px-4', 'py-2.5', 'align-middle', 'text-foreground/90', 'last:border-r-0');
    }

    scroll.appendChild(table);
    wrapper.appendChild(scroll);
  }
};

// ---------------------------------------------------------------------------
// Mermaid: replace ```mermaid code fences with rendered diagram blocks
// ---------------------------------------------------------------------------

const decorateMermaid = (root: HTMLElement, ctx: DecorateContext): void => {
  const codes = root.querySelectorAll<HTMLElement>('pre > code.language-mermaid');
  for (const code of Array.from(codes)) {
    const pre = code.parentElement as HTMLPreElement | null;
    if (!pre) continue;
    const source = (code.textContent ?? '').replace(/\s+$/, '');
    const rendered = ctx.renderMermaid(source);

    const block = document.createElement('div');
    block.setAttribute('data-markdown', 'mermaid-block');
    block.setAttribute('data-md-source', source);
    block.className = 'group relative';

    const scroll = document.createElement('div');
    scroll.setAttribute('data-markdown', 'mermaid-scroll');

    const toolbar = document.createElement('div');
    toolbar.setAttribute('data-markdown', 'mermaid-toolbar');
    toolbar.className = 'absolute top-1 right-2 flex items-center gap-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity';

    if (rendered.svg) {
      block.setAttribute('data-mermaid-render', 'svg');
      const viewport = document.createElement('div');
      viewport.setAttribute('data-markdown', 'mermaid-viewport');
      const svgHost = document.createElement('div');
      svgHost.setAttribute('data-markdown', 'mermaid');
      svgHost.setAttribute('data-md-original-svg', rendered.svg);
      svgHost.innerHTML = rendered.svg;
      viewport.appendChild(svgHost);
      scroll.appendChild(viewport);
      if (ctx.mermaidControls.showPanZoomControls) {
        toolbar.appendChild(makeIconButton('zoomIn', ctx.labels.zoomInDiagram, 'mermaid-zoom-in'));
        toolbar.appendChild(makeIconButton('zoomOut', ctx.labels.zoomOutDiagram, 'mermaid-zoom-out'));
        toolbar.appendChild(makeIconButton('fit', ctx.labels.resetDiagramView, 'mermaid-fit'));
      }
      if (ctx.mermaidControls.copy) {
        const copy = makeIconButton('copy', ctx.labels.copyDiagram, 'mermaid-copy');
        copy.setAttribute('data-md-source', source);
        toolbar.appendChild(copy);
      }
      if (ctx.mermaidControls.download) {
        const download = makeIconButton('download', ctx.labels.downloadDiagram, 'mermaid-download');
        download.setAttribute('data-md-svg', '1');
        toolbar.appendChild(download);
      }
    } else {
      block.setAttribute('data-mermaid-render', 'ascii');
      const asciiPre = document.createElement('pre');
      asciiPre.setAttribute('data-markdown', 'mermaid-ascii');
      asciiPre.textContent = rendered.ascii || source;
      scroll.appendChild(asciiPre);
      if (ctx.mermaidControls.copy) {
        const copy = makeIconButton('copy', ctx.labels.copyDiagram, 'mermaid-copy');
        copy.setAttribute('data-md-source', rendered.ascii || source);
        toolbar.appendChild(copy);
      }
    }

    block.appendChild(scroll);
    block.appendChild(toolbar);

    const host = pre.parentElement;
    if (!host) continue;
    host.replaceChild(block, pre);
  }
};

// ---------------------------------------------------------------------------
// External links: favicon + loopback preview button
// ---------------------------------------------------------------------------

const decorateLinks = (root: HTMLElement, ctx: DecorateContext): void => {
  const anchors = root.querySelectorAll<HTMLAnchorElement>('a[href]');
  for (const anchor of Array.from(anchors)) {
    if (anchor.getAttribute('data-md-link-decorated') === 'true') continue;
    if (anchor.getAttribute('data-openchamber-file-link') === 'true') continue;
    const href = anchor.getAttribute('href') ?? '';
    if (!isExternalHttpUrl(href)) continue;
    anchor.setAttribute('data-md-link-decorated', 'true');

    const faviconUrl = getExternalFaviconUrl(href);
    if (faviconUrl) {
      const favWrap = document.createElement('span');
      favWrap.className =
        'mr-1 inline-flex size-[18px] items-center justify-center rounded border border-[var(--border)] bg-[var(--interactive-hover)] align-middle';
      const img = document.createElement('img');
      img.src = faviconUrl;
      img.alt = '';
      img.setAttribute('aria-hidden', 'true');
      img.loading = 'lazy';
      img.decoding = 'async';
      img.className = 'size-3.5 rounded-sm';
      img.addEventListener('error', () => favWrap.remove(), { once: true });
      favWrap.appendChild(img);
      anchor.parentNode?.insertBefore(favWrap, anchor);
    }

    if (ctx.onPreviewLoopback && isLoopbackHttpUrl(href)) {
      const preview = document.createElement('button');
      preview.type = 'button';
      preview.className = `ml-1 align-middle ${ICON_BTN_CLASS}`;
      preview.setAttribute('data-md-action', 'preview-loopback');
      preview.setAttribute('data-md-url', href);
      preview.setAttribute('title', ctx.labels.previewTitle);
      preview.setAttribute('aria-label', ctx.labels.previewLabel);
      setIconHtml(preview, ICONS.download);
      anchor.parentNode?.insertBefore(preview, anchor.nextSibling);
    }
  }
};

/** Run all idempotent DOM decoration passes over freshly-rendered markdown. */
export const decorateMarkdown = (root: HTMLElement, ctx: DecorateContext): void => {
  decorateInlineCode(root);
  decorateMermaid(root, ctx);
  decorateCodeBlocks(root, ctx);
  decorateTables(root);
  decorateLinks(root, ctx);
};

// ---------------------------------------------------------------------------
// Delegated interactions (copy/download/menus/preview)
// ---------------------------------------------------------------------------

const downloadBlob = (filename: string, content: string, mime: string): void => {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
};

/**
 * Attach a single delegated click listener for all in-markdown actions: code
 * and mermaid copy/download, plus loopback preview.
 * Returns a cleanup function.
 */
export const attachMarkdownInteractions = (
  container: HTMLElement,
  ctx: DecorateContext,
): (() => void) => {
  const handleClick = (event: MouseEvent) => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    const actionEl = target.closest<HTMLElement>('[data-md-action]');
    if (!actionEl) {
      return;
    }
    const action = actionEl.getAttribute('data-md-action') ?? '';

    // Copy code
    if (action === 'copy-code') {
      const code = actionEl.closest('[data-component="markdown-code"]')?.querySelector('code');
      const text = code?.textContent ?? '';
      if (text) void copyTextToClipboard(text).then(() => flashCopied(actionEl as HTMLButtonElement, ctx.labels.copied, 'copy', ctx.labels.copy));
      return;
    }

    if (action === 'toggle-code-wrap') {
      event.preventDefault();
      ctx.onToggleCodeBlockLineWrap?.();
      return;
    }

    // Mermaid copy source / ascii
    if (action === 'mermaid-copy') {
      const source = actionEl.getAttribute('data-md-source') ?? '';
      if (source) void copyTextToClipboard(source).then(() => flashCopied(actionEl as HTMLButtonElement, ctx.labels.copied, 'copy', ctx.labels.copyDiagram));
      return;
    }

    // Mermaid local pan/zoom controls
    if (action === 'mermaid-zoom-in' || action === 'mermaid-zoom-out' || action === 'mermaid-fit') {
      event.preventDefault();
      const block = actionEl.closest('[data-markdown="mermaid-block"]');
      const controller = getMermaidViewerController(block);
      if (action === 'mermaid-zoom-in') {
        controller?.zoomIn();
      } else if (action === 'mermaid-zoom-out') {
        controller?.zoomOut();
      } else {
        controller?.fit();
      }
      return;
    }

    // Mermaid download svg
    if (action === 'mermaid-download') {
      const svgHost = actionEl.closest('[data-markdown="mermaid-block"]')?.querySelector('[data-markdown="mermaid"]');
      const svg = svgHost?.getAttribute('data-md-original-svg') ?? svgHost?.innerHTML ?? '';
      if (svg) downloadBlob('diagram.svg', svg, 'image/svg+xml;charset=utf-8');
      return;
    }

    // Loopback preview
    if (action === 'preview-loopback') {
      event.preventDefault();
      const url = actionEl.getAttribute('data-md-url') ?? '';
      if (url) ctx.onPreviewLoopback?.(url);
      return;
    }
  };

  container.addEventListener('click', handleClick);
  return () => container.removeEventListener('click', handleClick);
};
