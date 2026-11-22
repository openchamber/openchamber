import React from 'react';

import { cn } from '@/lib/utils';

export function FilePathLabel({ path, className, title = path, trailing }: {
  path: string;
  className?: string;
  title?: string | null;
  trailing?: React.ReactNode;
}) {
  const boxRef = React.useRef<HTMLSpanElement | null>(null);
  const measureRef = React.useRef<HTMLSpanElement | null>(null);
  const [fits, setFits] = React.useState(true);
  const name = path.split(/[\\/]/).filter(Boolean).pop() ?? path;

  React.useLayoutEffect(() => {
    const box = boxRef.current;
    const measure = measureRef.current;
    if (!box || !measure) return;
    const update = () => setFits(measure.offsetWidth <= box.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(box);
    return () => observer.disconnect();
  }, [path]);

  return (
    <span ref={boxRef} className={cn('relative min-w-0 flex-1 overflow-hidden', className)} title={title ?? undefined} dir="ltr">
      <span ref={measureRef} aria-hidden className={cn('invisible absolute whitespace-nowrap', trailing ? 'pe-[18px]' : undefined)}>{path}</span>
      {trailing ? (
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 truncate">{fits ? path : name}</span>
          {trailing}
        </span>
      ) : <span className="block truncate">{fits ? path : name}</span>}
    </span>
  );
}
