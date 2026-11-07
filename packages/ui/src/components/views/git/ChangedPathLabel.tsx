import { cn } from '@/lib/utils';

/**
 * A changed file's path on one line that keeps the file name whole: the folder
 * is muted and gives way first, cut from its start, so a narrow row still says
 * which file it is. The full path is the tooltip. Typography comes from the
 * caller through `className`.
 */
export const ChangedPathLabel = ({ path, from, className, nameFirst = false }: {
  path: string;
  /** The path a rename came from. */
  from?: string;
  className?: string;
  /** For a list on a phone: names line up in a column and the folder trails after them. */
  nameFirst?: boolean;
}) => {
  const lastSlash = path.lastIndexOf('/');
  const dir = lastSlash === -1 ? '' : path.slice(0, lastSlash);
  const name = path.slice(lastSlash + 1);
  const fromSlash = from ? from.lastIndexOf('/') : -1;
  const fromDir = from && fromSlash !== -1 ? from.slice(0, fromSlash) : '';
  const title = from ? `${from} → ${path}` : path;

  if (lastSlash === -1 && !from) {
    return (
      <span dir="ltr" className={cn('block min-w-0 truncate text-foreground', className)} title={title}>
        {path}
      </span>
    );
  }

  return (
    <span
      dir="ltr"
      className={cn('flex min-w-0 items-baseline overflow-hidden', nameFirst && 'gap-2', className)}
      title={title}
    >
      {from ? (
        <>
          <span
            className="oc-ui-start-align min-w-0 truncate text-muted-foreground"
            style={{ direction: 'rtl', unicodeBidi: 'plaintext' }}
          >
            {from}
          </span>
          <span className="shrink-0 px-1 text-muted-foreground">{'→'}</span>
        </>
      ) : null}
      {nameFirst ? (
        <>
          <span className="max-w-full shrink-0 truncate text-foreground">{name}</span>
          {dir && dir !== fromDir ? <span className="min-w-0 truncate typography-micro text-muted-foreground">{dir}</span> : null}
        </>
      ) : (
        <>
          {dir ? (
            <span
              className="oc-ui-start-align min-w-0 truncate text-muted-foreground"
              style={{ direction: 'rtl', unicodeBidi: 'plaintext' }}
            >
              {dir}
            </span>
          ) : null}
          {/* Holds its width, so the folder gives way first; a name wider than the
              whole row takes an ellipsis instead of a cut letter. */}
          <span className="max-w-full shrink-0 truncate">
            {dir ? <span className="text-muted-foreground">/</span> : null}
            <span className="text-foreground">{name}</span>
          </span>
        </>
      )}
    </span>
  );
};
