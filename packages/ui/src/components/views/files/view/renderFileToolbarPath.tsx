import { TooltipLabelWithShortcut } from '@/components/ui/action-toolbar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { FilePathLabel } from '../FilePathLabel';
import { cn } from '@/lib/utils';
import { Icon } from '@/components/icon/Icon';
import { type useFileKinds } from './useFileKinds';
import { useFileClipboard } from './useFileClipboard';

export function renderFileToolbarPath({ clipboard, fileKinds, copyPathLabel, docked, pathLabelCopies, showsPathLabel }: {
  clipboard: Pick<ReturnType<typeof useFileClipboard>, 'copiedPath' | 'copyPath'>;
  fileKinds: Pick<ReturnType<typeof useFileKinds>, 'displaySelectedPath'>;
  copyPathLabel: string;
  docked: boolean;
  pathLabelCopies: boolean;
  showsPathLabel: boolean;
}) {
  const { copiedPath, copyPath } = clipboard;
  const { displaySelectedPath } = fileKinds;
  return (
docked ? (
          showsPathLabel ? (
            pathLabelCopies ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => void copyPath(false)}
                    aria-label={copyPathLabel}
                    className="group/path flex min-w-0 flex-1 items-center text-start typography-meta text-muted-foreground transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:outline-none"
                  >
                    <FilePathLabel
                      path={displaySelectedPath}
                      title={null}
                      trailing={(
                        <Icon
                          name={copiedPath ? 'check' : 'file-copy'}
                          className={cn(
                            'size-3 shrink-0 transition-opacity',
                            copiedPath ? 'text-[color:var(--status-success)] opacity-100' : 'opacity-0 group-hover/path:opacity-100 group-focus-visible/path:opacity-100',
                          )}
                        />
                      )}
                    />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" sideOffset={6}><TooltipLabelWithShortcut label={copyPathLabel} /></TooltipContent>
              </Tooltip>
            ) : (
              <FilePathLabel path={displaySelectedPath} className="typography-meta text-muted-foreground" />
            )
          ) : null
        ) : undefined
  );
}
