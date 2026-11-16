import React from 'react';
import { Streamdown } from 'streamdown';

import { cn } from '@/lib/utils';

/**
 * `MarkdownContent` inside a shared page: the block's text and tables through
 * the same Markdown parser the chat uses, without what only the app has (file
 * links, local images, highlighting workers, extension links). Raw HTML stays
 * text and links open nowhere: the page cannot navigate.
 */
export function MarkdownContent({ content, className }: { content: string; className?: string }) {
  return (
    <div data-markdown-content="" className={cn('markdown-content break-words w-full min-w-0 leading-relaxed', className)}>
      <Streamdown mode="static" controls={false} linkSafety={{ enabled: false }} className="min-w-0 space-y-0">
        {content}
      </Streamdown>
    </div>
  );
}
