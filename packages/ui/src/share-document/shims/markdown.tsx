import React from 'react';
import { Streamdown } from 'streamdown';

import { cn } from '@/lib/utils';

export function MarkdownContent({ content, className }: { content: string; className?: string }) {
  return (
    <div data-markdown-content="" className={cn('markdown-content break-words w-full min-w-0 leading-relaxed', className)}>
      <Streamdown mode="static" controls={false} linkSafety={{ enabled: false }} className="min-w-0 space-y-0">
        {content}
      </Streamdown>
    </div>
  );
}
