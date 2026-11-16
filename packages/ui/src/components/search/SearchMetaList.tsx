import React from 'react';

import { cn } from '@/lib/utils';

export type SearchMetaItem = {
  key: string;
  text: string;
  dir: 'auto' | 'ltr';
  icon?: React.ReactNode;
  title?: string;
  iconLabel?: string;
  priority?: 'keep' | 'yield';
};

export const SearchMetaList: React.FC<{ items: readonly SearchMetaItem[]; className?: string }> = ({ items, className }) => {
  if (items.length === 0) return null;

  return <span data-search-meta className={cn('flex min-w-0 items-center gap-x-1.5 overflow-hidden whitespace-nowrap', className)}>
    {items.map((item, index) => <React.Fragment key={item.key}>
      {!item.icon && index > 0 ? <span aria-hidden="true" data-search-meta-divider className="h-3 w-px shrink-0 bg-edge" /> : null}
      <span data-search-meta-item={item.key} title={item.title ?? item.text} className={cn('inline-flex min-w-0 items-center gap-1', item.priority === 'keep' ? 'shrink-0' : item.priority === 'yield' ? 'shrink-[3]' : 'shrink')}>
        {item.icon ? <span data-search-meta-icon className="inline-flex size-3 shrink-0 items-center justify-center text-muted-foreground" {...(item.iconLabel ? { role: 'img', 'aria-label': item.iconLabel } : { 'aria-hidden': true })}>{item.icon}</span> : null}
        <span dir={item.dir} className="min-w-0 truncate">{item.text}</span>
      </span>
    </React.Fragment>)}
  </span>;
};
