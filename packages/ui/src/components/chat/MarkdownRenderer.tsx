import React from 'react';
import { lazyWithChunkRecovery } from '@/lib/chunkLoadRecovery';
import { cn } from '@/lib/utils';
import { loadMarkdownRendererModule } from './markdownRendererLoader';
import { useMarkdownHydrationEnabled } from './markdown/markdownHydrationContext';
import { MarkdownLoadingPlaceholder } from './markdown/MarkdownLoadingSkeleton';

// Thin lazy wrapper around the MarkdownRenderer implementation.
// The full implementation (marked + Shiki highlighting + KaTeX + morphdom
// DOM morphing, plus beautiful-mermaid) is loaded on demand, keeping the
// initial bundle lean.

const MarkdownRendererLazy = lazyWithChunkRecovery(() =>
  loadMarkdownRendererModule().then((m) => ({ default: m.MarkdownRenderer }))
);

const SimpleMarkdownRendererLazy = lazyWithChunkRecovery(() =>
  loadMarkdownRendererModule().then((m) => ({ default: m.SimpleMarkdownRenderer }))
);

const fallbackContentClassName = (variant: unknown): string => {
  if (variant === 'tool') return 'markdown-content markdown-tool';
  if (variant === 'reasoning') return 'markdown-content markdown-reasoning';
  return 'markdown-content leading-relaxed';
};

const MarkdownSkeletonFallback = (props: {
  animated?: boolean;
  content?: unknown;
  className?: unknown;
  variant?: unknown;
}) => {
  const content = typeof props.content === 'string' ? props.content : '';
  return (
    <div
      className={cn(
        'relative break-words w-full min-w-0',
        fallbackContentClassName(props.variant),
        typeof props.className === 'string' ? props.className : undefined,
      )}
      aria-busy="true"
      data-markdown-hydration="deferred"
    >
      <MarkdownLoadingPlaceholder animated={props.animated} content={content} />
    </div>
  );
};

export const MarkdownRenderer: React.FC<React.ComponentPropsWithoutRef<typeof MarkdownRendererLazy>> = (props) => {
  const hydrationEnabled = useMarkdownHydrationEnabled();
  if (!hydrationEnabled && props.isStreaming !== true) {
    return <MarkdownSkeletonFallback {...props} animated={false} />;
  }

  return (
    <React.Suspense fallback={<MarkdownSkeletonFallback {...props} />}>
      <MarkdownRendererLazy {...props} />
    </React.Suspense>
  );
};

export const SimpleMarkdownRenderer: React.FC<React.ComponentPropsWithoutRef<typeof SimpleMarkdownRendererLazy>> = (props) => {
  const hydrationEnabled = useMarkdownHydrationEnabled();
  if (!hydrationEnabled) {
    return <MarkdownSkeletonFallback {...props} animated={false} />;
  }

  return (
    <React.Suspense fallback={<MarkdownSkeletonFallback {...props} />}>
      <SimpleMarkdownRendererLazy {...props} />
    </React.Suspense>
  );
};
