import React from 'react';
import { lazyWithChunkRecovery } from '@/lib/chunkLoadRecovery';
import { isMobileSurfaceRuntime } from '@/lib/runtimeSurface';
import { cn } from '@/lib/utils';
import { loadMarkdownRendererModule } from './markdownRendererLoader';

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

const fallback = <div className="break-words w-full min-w-0" />;

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
    <div className={cn('break-words w-full min-w-0 whitespace-pre-wrap', fallbackContentClassName(props.variant), typeof props.className === 'string' ? props.className : undefined)}>
      {props.content}
    </div>
  );
};

export const MarkdownRenderer: React.FC<React.ComponentPropsWithoutRef<typeof MarkdownRendererLazy>> = (props) => (
  <React.Suspense fallback={<MobileMarkdownFallback {...props} />}>
    <MarkdownRendererLazy {...props} />
  </React.Suspense>
);

export const SimpleMarkdownRenderer: React.FC<React.ComponentPropsWithoutRef<typeof SimpleMarkdownRendererLazy>> = (props) => (
  <React.Suspense fallback={<MobileMarkdownFallback {...props} />}>
    <SimpleMarkdownRendererLazy {...props} />
  </React.Suspense>
);
