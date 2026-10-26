import { cn } from '@/lib/utils';

/**
 * A changed file's path on one line that keeps the file name whole: the folder
 * is muted and gives way first, cut from its start, so a narrow row still says
 * which file it is. The full path is the tooltip. Typography comes from the
 * caller through `className`.
 */
export const ChangedPathLabel = ({ path, className }: { path: string; className?: string }) => {
  const lastSlash = path.lastIndexOf('/');
  if (lastSlash === -1) {
    return (
      <span dir="ltr" className={cn('block min-w-0 truncate text-foreground', className)} title={path}>
        {path}
      </span>
    );
  }
  return (
    <span dir="ltr" className={cn('flex min-w-0 items-baseline overflow-hidden', className)} title={path}>
      <span
        className="oc-ui-start-align min-w-0 truncate text-muted-foreground"
        style={{ direction: 'rtl', unicodeBidi: 'plaintext' }}
      >
        {path.slice(0, lastSlash)}
      </span>
      <span className="shrink-0">
        <span className="text-muted-foreground">/</span>
        <span className="text-foreground">{path.slice(lastSlash + 1)}</span>
      </span>
    </span>
  );
};
