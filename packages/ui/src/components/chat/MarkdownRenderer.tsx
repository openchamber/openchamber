import React from 'react';
import { lazyWithChunkRecovery } from '@/lib/chunkLoadRecovery';
import { isMobileSurfaceRuntime } from '@/lib/runtimeSurface';
import { cn } from '@/lib/utils';
import { getLoadedMarkdownRendererModule, loadMarkdownRendererModule } from './markdownRendererLoader';
import type { MarkdownContentProps, MarkdownRendererProps, SimpleMarkdownRendererProps as SimpleRendererProps } from './MarkdownRendererImpl';

// Thin lazy wrapper around the MarkdownRenderer implementation.
// Streamdown, its official plugins and beautiful-mermaid load on demand, keeping the
// initial bundle lean.

const MarkdownRendererLazy = lazyWithChunkRecovery(() =>
  loadMarkdownRendererModule().then((m) => ({ default: m.MarkdownRenderer }))
);

const SimpleMarkdownRendererLazy = lazyWithChunkRecovery(() =>
  loadMarkdownRendererModule().then((m) => ({ default: m.SimpleMarkdownRenderer }))
);

const MarkdownContentLazy = lazyWithChunkRecovery(() =>
  loadMarkdownRendererModule().then((m) => ({ default: m.MarkdownContent }))
);

const fallback = <div data-chat-quote-pending className="break-words w-full min-w-0" />;

const fallbackContentClassName = (variant: unknown): string => {
  if (variant === 'tool') return 'markdown-content markdown-tool';
  if (variant === 'reasoning') return 'markdown-content markdown-reasoning';
  return 'markdown-content leading-relaxed';
};

const MobileMarkdownFallback = (props: { content?: unknown; className?: unknown; variant?: unknown }) => {
  if (!isMobileSurfaceRuntime() || typeof props.content !== 'string' || props.content.length === 0) {
    return fallback;
  }

  return (
    <div data-chat-quote-pending className={cn('break-words w-full min-w-0 whitespace-pre-wrap', fallbackContentClassName(props.variant), typeof props.className === 'string' ? props.className : undefined)}>
      {props.content}
    </div>
  );
};

export const MarkdownRenderer: React.FC<MarkdownRendererProps> = (props) => {
  const loaded = getLoadedMarkdownRendererModule();
  if (loaded) return <loaded.MarkdownRenderer {...props} />;
  return (
    <React.Suspense fallback={<MobileMarkdownFallback {...props} />}>
      <MarkdownRendererLazy {...props} />
    </React.Suspense>
  );
};

export const MarkdownContent: React.FC<MarkdownContentProps> = (props) => {
  // Chosen once per mount: swapping the lazy component for the loaded one at
  // the same spot would remount the content and load its media again.
  const [loaded] = React.useState(getLoadedMarkdownRendererModule);
  if (loaded) return <loaded.MarkdownContent {...props} />;
  return (
    <React.Suspense fallback={fallback}>
      <MarkdownContentLazy {...props} />
    </React.Suspense>
  );
};

type SimpleMarkdownRendererProps = SimpleRendererProps & {
  fallbackContent?: React.ReactNode;
};

export const SimpleMarkdownRenderer: React.FC<SimpleMarkdownRendererProps> = ({ fallbackContent, ...props }) => {
  const loaded = getLoadedMarkdownRendererModule();
  if (loaded) return <loaded.SimpleMarkdownRenderer {...props} />;
  return (
    <React.Suspense fallback={fallbackContent == null ? <MobileMarkdownFallback {...props} /> : <div data-chat-quote-pending>{fallbackContent}</div>}>
      <SimpleMarkdownRendererLazy {...props} />
    </React.Suspense>
  );
};
