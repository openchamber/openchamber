import React from 'react';

import { cn } from '@/lib/utils';
import { SimpleMarkdownRenderer } from './MarkdownRenderer';

interface QuestionMarkdownProps {
  content: string;
  size: 'meta' | 'micro';
  className?: string;
}

export function QuestionMarkdown({ content, size, className }: QuestionMarkdownProps) {
  const classes = cn('question-markdown', size === 'meta' ? 'typography-meta' : 'typography-micro', className);

  return (
    <SimpleMarkdownRenderer
      content={content}
      variant="tool"
      className={classes}
      fallbackContent={<div className={cn(classes, 'whitespace-pre-wrap')}>{content}</div>}
    />
  );
}
