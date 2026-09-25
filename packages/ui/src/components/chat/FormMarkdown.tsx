import React from 'react';

import { cn } from '@/lib/utils';
import { SimpleMarkdownRenderer } from './MarkdownRenderer';

interface FormMarkdownProps {
  content: string;
  size: 'meta' | 'micro';
  className?: string;
}

export function FormMarkdown({ content, size, className }: FormMarkdownProps) {
  const classes = cn('form-markdown', size === 'meta' ? 'typography-meta' : 'typography-micro', className);

  return (
    <SimpleMarkdownRenderer
      content={content}
      variant="tool"
      className={classes}
      fallbackContent={<div className={cn(classes, 'whitespace-pre-wrap')}>{content}</div>}
    />
  );
}
