import React from 'react';
import { lazyWithChunkRecovery } from '@/lib/chunkLoadRecovery';

// Thin lazy wrapper around the MarkdownRenderer implementation.
// The full implementation (marked + Shiki highlighting + KaTeX + morphdom
// DOM morphing, plus beautiful-mermaid) is loaded on demand, keeping the
// initial bundle lean.

const MarkdownRendererLazy = lazyWithChunkRecovery(() =>
  import('./MarkdownRendererImpl').then((m) => ({ default: m.MarkdownRenderer }))
);

const SimpleMarkdownRendererLazy = lazyWithChunkRecovery(() =>
  import('./MarkdownRendererImpl').then((m) => ({ default: m.SimpleMarkdownRenderer }))
);

const fallback = <div className="break-words w-full min-w-0" />;

export const MarkdownRenderer: React.FC<React.ComponentPropsWithoutRef<typeof MarkdownRendererLazy>> = (props) => (
  <React.Suspense fallback={fallback}>
    <MarkdownRendererLazy {...props} />
  </React.Suspense>
);

export const SimpleMarkdownRenderer: React.FC<React.ComponentPropsWithoutRef<typeof SimpleMarkdownRendererLazy>> = (props) => (
  <React.Suspense fallback={fallback}>
    <SimpleMarkdownRendererLazy {...props} />
  </React.Suspense>
);
