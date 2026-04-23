import React from 'react';

// Thin lazy wrapper around the heavy MarkdownRenderer implementation.
// The full implementation (marked, react-markdown, beautiful-mermaid,
// react-syntax-highlighter, etc.) is loaded on demand, keeping the
// initial bundle lean.

export type { MarkdownVariant } from './MarkdownRendererImpl';


const MarkdownRendererLazy = React.lazy(() =>
  import('./MarkdownRendererImpl').then((m) => ({ default: m.MarkdownRenderer }))
);

const SimpleMarkdownRendererLazy = React.lazy(() =>
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
