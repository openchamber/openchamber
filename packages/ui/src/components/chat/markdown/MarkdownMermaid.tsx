import React from 'react';
import { renderMermaidASCII, renderMermaidSVG } from 'beautiful-mermaid';
import type { CustomRendererProps } from 'streamdown';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { copyTextToClipboard } from '@/lib/clipboard';
import { useUIStore } from '@/stores/useUIStore';
import { useMarkdownPresentation } from './MarkdownPresentationContext';
import { createMermaidViewerController, MERMAID_BLOCK_SELECTOR } from './mermaidViewer';

type MermaidResult = { svg?: string; ascii?: string };
const renderCache = new Map<string, MermaidResult>();
const screenColors = {
  bg: 'var(--surface-elevated)',
  fg: 'var(--surface-foreground)',
  line: 'var(--surface-muted-foreground)',
  accent: 'var(--primary-base)',
  muted: 'var(--surface-muted-foreground)',
  surface: 'var(--surface-muted)',
  border: 'var(--interactive-border)',
};

// Keep the original 100-entry LRU across row remounts and fullscreen previews.
// CSS variable colors let one geometry result serve every screen theme.
function renderDiagram(source: string, mode: 'svg' | 'ascii'): MermaidResult {
  const key = `${mode}:${source}`;
  const cached = renderCache.get(key);
  if (cached) {
    renderCache.delete(key);
    renderCache.set(key, cached);
    return cached;
  }

  let result: MermaidResult;
  try {
    result = mode === 'ascii'
      ? { ascii: renderMermaidASCII(source) }
      : { svg: renderMermaidSVG(source, { ...screenColors, transparent: true, font: 'system-ui, sans-serif' }) };
  } catch {
    result = {};
  }
  renderCache.set(key, result);
  if (renderCache.size > 100) {
    const oldest = renderCache.keys().next().value;
    if (oldest !== undefined) renderCache.delete(oldest);
  }
  return result;
}

// The viewer mutates viewBox inside this SVG. Unrelated toolbar/context updates
// must leave that subtree alone; only a new diagram replaces its markup.
const MermaidSvg = React.memo(function MermaidSvg({ svg, viewer }: { svg: string; viewer: boolean }) {
  return (
    <div
      data-streamdown="mermaid"
      data-oc-mermaid-viewer={viewer ? '' : undefined}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
});

export function MarkdownMermaid({ code, isIncomplete }: CustomRendererProps) {
  const { theme, purpose, mermaidControls: controls, onShowPopup, allowMermaidWheelEvents } = useMarkdownPresentation();
  const mode = useUIStore((state) => state.mermaidRenderingMode);
  const { t } = useI18n();
  const host = React.useRef<HTMLDivElement>(null);
  const controller = React.useRef<ReturnType<typeof createMermaidViewerController>>(null);
  const [copied, setCopied] = React.useState(false);
  const copyTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const source = code.trimEnd();
  const result = React.useMemo(
    () => isIncomplete ? null : renderDiagram(source, mode),
    [source, isIncomplete, mode],
  );
  const svg = result?.svg;
  const text = result?.ascii || source;

  React.useEffect(() => {
    if (!host.current || !svg || purpose) return;
    // Button visibility does not disable drag, pinch or modified-wheel zoom.
    const active = createMermaidViewerController(host.current);
    controller.current = active;
    return () => {
      active?.cleanup();
      controller.current = null;
    };
  }, [svg, purpose]);

  React.useEffect(() => () => {
    if (copyTimer.current) clearTimeout(copyTimer.current);
  }, []);

  // Exports need self-contained colors and the original, uncropped geometry.
  // Resolve only our known palette references; never serialize the panned DOM.
  const exportSvg = () => {
    const colors = {
      'var(--surface-elevated)': theme.colors.surface.elevated,
      'var(--surface-foreground)': theme.colors.surface.foreground,
      'var(--surface-muted-foreground)': theme.colors.surface.mutedForeground,
      'var(--primary-base)': theme.colors.primary.base,
      'var(--surface-muted)': theme.colors.surface.muted,
      'var(--interactive-border)': theme.colors.interactive.border,
    };
    let exported = svg ?? '';
    for (const [variable, color] of Object.entries(colors)) exported = exported.replaceAll(variable, color);
    return exported;
  };

  const preview = (event: React.MouseEvent) => {
    if (purpose || !onShowPopup || !source || !(event.target instanceof Element)) return;
    if (event.target.closest('button, a, [role="button"]')) return;
    const block = host.current;
    if (!block) return;
    if (block.hasAttribute('data-mermaid-suppress-click')) {
      block.removeAttribute('data-mermaid-suppress-click');
      return;
    }
    const blocks = Array.from(block.closest('[data-markdown-content]')?.querySelectorAll(MERMAID_BLOCK_SELECTOR) ?? []);
    const filename = `${t('layout.mainTab.diagram')} ${blocks.indexOf(block) + 1}`;
    onShowPopup({
      open: true,
      title: filename,
      content: '',
      metadata: { tool: 'mermaid-preview', filename },
      mermaid: { source, url: `data:text/plain;charset=utf-8,${encodeURIComponent(source)}`, filename },
    });
  };

  const copy = async () => {
    const copiedResult = await copyTextToClipboard(svg ? source : text);
    if (!copiedResult.ok) return;
    setCopied(true);
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(false), 2000);
  };

  const download = () => {
    if (!svg) return;
    const url = URL.createObjectURL(new Blob([exportSvg()], { type: 'image/svg+xml;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'diagram.svg';
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div
      ref={host}
      dir="ltr"
      data-streamdown="mermaid-block"
      data-oc-mermaid-source={source}
      data-mermaid-render={svg ? 'svg' : 'ascii'}
      onClick={preview}
      onWheelCapture={(event) => {
        if (!allowMermaidWheelEvents && !event.ctrlKey && !event.metaKey) event.stopPropagation();
      }}
    >
      <div data-streamdown="mermaid-scroll">
        {svg ? (
          <div data-streamdown="mermaid-viewport">
            <MermaidSvg svg={purpose ? exportSvg() : svg} viewer={!purpose} />
          </div>
        ) : (
          <pre data-streamdown="mermaid-ascii">{text}</pre>
        )}
      </div>
      {!purpose && (
        <div
          data-streamdown="mermaid-toolbar"
          data-export-ignore
          className="absolute top-1 inset-e-2 flex items-center gap-1"
        >
          {controls.showPanZoomControls && svg && (
            <>
              <Button variant="ghost" size="xs" title={t('markdownRenderer.mermaid.actions.zoomInTitle')} onClick={() => controller.current?.zoomIn()}>
                <Icon name="add" className="size-3.5" />
              </Button>
              <Button variant="ghost" size="xs" title={t('markdownRenderer.mermaid.actions.zoomOutTitle')} onClick={() => controller.current?.zoomOut()}>
                <Icon name="subtract" className="size-3.5" />
              </Button>
              <Button variant="ghost" size="xs" title={t('markdownRenderer.mermaid.actions.resetViewTitle')} onClick={() => controller.current?.fit()}>
                <Icon name="refresh" className="size-3.5" />
              </Button>
            </>
          )}
          {controls.copy && (
            <Button variant="ghost" size="xs" title={t(copied ? 'markdownRenderer.code.actions.copiedTitle' : 'markdownRenderer.mermaid.actions.copyTitle')} onClick={copy}>
              <Icon name={copied ? 'check' : 'file-copy'} className="size-3.5" />
            </Button>
          )}
          {controls.download && svg && (
            <Button variant="ghost" size="xs" title={t('markdownRenderer.mermaid.actions.downloadSvgTitle')} onClick={download}>
              <Icon name="download" className="size-3.5" />
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
