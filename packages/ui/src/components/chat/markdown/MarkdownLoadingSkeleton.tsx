import React from 'react';

import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

const MAX_SKELETON_LINES = 5;
const WRAPPED_LINE_CHARACTER_ESTIMATE = 88;
const SKELETON_LINE_WIDTHS = [
  'w-full',
  'w-[92%]',
  'w-[84%]',
  'w-[96%]',
] as const;

const estimateSkeletonLineCount = (content: string): number => {
  const trimmed = content.trim();
  if (!trimmed) return 1;

  const explicitLines = trimmed.split(/\n+/).length;
  const wrappedLines = Math.ceil(trimmed.length / WRAPPED_LINE_CHARACTER_ESTIMATE);
  return Math.min(MAX_SKELETON_LINES, Math.max(1, explicitLines, wrappedLines));
};

/**
 * Keeps the cheap plain-text layout as an invisible size spacer while showing
 * only a bounded skeleton. Rich Markdown can replace it without exposing raw
 * source syntax or creating dozens of animated placeholder nodes.
 */
export const MarkdownLoadingPlaceholder: React.FC<{
  animated?: boolean;
  content: string;
}> = ({ animated = true, content }) => {
  const lineCount = estimateSkeletonLineCount(content);
  const showSkeleton = content.trim().length > 0;

  return (
    <>
      <span
        aria-hidden="true"
        className="invisible block whitespace-pre-wrap"
        data-markdown-size-spacer="true"
      >
        {content || '\u00a0'}
      </span>
      {showSkeleton && (
        <div
          aria-hidden="true"
          className={cn(
            'pointer-events-none absolute inset-0 flex w-full flex-col gap-2 overflow-hidden py-1',
            animated && 'motion-safe:animate-pulse',
          )}
          data-markdown-placeholder="skeleton"
        >
          {Array.from({ length: lineCount }, (_, index) => (
            <Skeleton
              key={index}
              className={cn(
                'h-3.5 animate-none',
                index === lineCount - 1
                  ? 'w-[68%]'
                  : SKELETON_LINE_WIDTHS[index % SKELETON_LINE_WIDTHS.length],
              )}
            />
          ))}
        </div>
      )}
    </>
  );
};
