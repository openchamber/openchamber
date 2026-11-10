import { cn } from '@/lib/utils';

/**
 * A changed file's path on one line that keeps the file name whole: the folder
 * is muted and gives way first, cut from its start, so a narrow row still says
 * which file it is. The full path is the tooltip. Typography comes from the
 * caller through `className`.
 */
export const ChangedPathLabel = ({ path, className, nameFirst = false }: {
  path: string;
  className?: string;
  /** For a list on a phone: names line up in a column and the folder trails after them. */
  nameFirst?: boolean;
}) => {
  const lastSlash = path.lastIndexOf('/');
  if (lastSlash === -1) {
    return (
      <span dir="ltr" className={cn('block min-w-0 truncate text-foreground', className)} title={path}>
        {path}
      </span>
    );
  }
  if (nameFirst) {
    return (
      <span dir="ltr" className={cn('flex min-w-0 items-baseline gap-2 overflow-hidden', className)} title={path}>
        <span className="max-w-full shrink-0 truncate text-foreground">{path.slice(lastSlash + 1)}</span>
        <span className="min-w-0 truncate typography-micro text-muted-foreground">{path.slice(0, lastSlash)}</span>
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
      {/* Holds its width, so the folder gives way first; a name wider than the
          whole row takes an ellipsis instead of a cut letter. */}
      <span className="max-w-full shrink-0 truncate">
        <span className="text-muted-foreground">/</span>
        <span className="text-foreground">{path.slice(lastSlash + 1)}</span>
      </span>
    </span>
  );
};
