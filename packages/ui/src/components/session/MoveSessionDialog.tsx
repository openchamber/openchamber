import React from 'react';

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { normalizePath } from '@/lib/pathNormalization';
import { formatDirectoryName, formatPathForDisplay } from '@/lib/utils';
import { buildSessionTreeMoveMessages, requestSessionTreeMove } from '@/lib/worktrees/sessionWorktreeMove';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useProjectsInSidebarOrder } from '@/components/session/sidebar/list/useProjectsInSidebarOrder';
import { collectSessionMoveDescendants } from '@/components/session/sidebar/sessions/sessionSubtreeActions';
import { DirectoryExplorerDialog } from '@/components/session/DirectoryExplorerDialog';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { isVSCodeRuntime } from '@/lib/desktop';

const ROW_CLASS = 'flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-start hover:bg-[var(--interactive-hover)] focus-visible:bg-[var(--interactive-hover)] focus-visible:outline-none disabled:pointer-events-none';

/**
 * Picks the folder a session moves into: a project's root, or another folder,
 * which joins the projects first. The conversation and its subsessions move;
 * nothing on disk does, which the description says before anything happens.
 * Works from a folder that is gone, because OpenCode's move does not open the
 * folder it leaves.
 */
export const MoveSessionDialog: React.FC<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId: string;
  sourceDirectory: string;
}> = ({ open, onOpenChange, sessionId, sourceDirectory }) => {
  const { t } = useI18n();
  const projects = useProjectsInSidebarOrder(useProjectsStore((state) => state.projects), open);
  const homeDirectory = useDirectoryStore((state) => state.homeDirectory);
  const [choosingFolder, setChoosingFolder] = React.useState(false);
  const currentDirectory = normalizePath(sourceDirectory);

  const moveTo = (directory: string) => {
    onOpenChange(false);
    // A subsession's composer moves the whole tree in this folder, so it never
    // leaves its parent behind. The index holds archived sessions too.
    const { entityById } = useGlobalSessionsStore.getState();
    let root = entityById.get(sessionId);
    if (!root) return;
    for (let parent = entityById.get(root.parentID ?? ''); parent?.directory === root.directory; parent = entityById.get(root.parentID ?? '')) {
      root = parent;
    }
    requestSessionTreeMove({
      kind: 'project',
      root,
      descendants: collectSessionMoveDescendants(root, []),
      sourceDirectory,
      projectDirectory: directory,
      messages: buildSessionTreeMoveMessages(t, {
        success: 'sessions.moveSession.success',
        failure: 'sessions.moveSession.failed',
      }),
    });
  };

  return (
    <>
      <Dialog open={open && !choosingFolder} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('sessions.moveSession.title')}</DialogTitle>
            <DialogDescription>{t('sessions.moveSession.description')}</DialogDescription>
          </DialogHeader>
          <ScrollableOverlay outerClassName="max-h-[50vh]" className="flex flex-col gap-0.5" disableHorizontal>
            {projects.map((project) => {
              const isCurrent = normalizePath(project.path) === currentDirectory;
              return (
                <button key={project.id} type="button" className={ROW_CLASS} disabled={isCurrent} onClick={() => moveTo(project.path)}>
                  <Icon name="folder" className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate typography-ui-label text-foreground">
                    {project.label?.trim() || formatDirectoryName(project.path)}
                  </span>
                  <span className="min-w-0 max-w-[45%] truncate typography-micro text-muted-foreground">
                    {formatPathForDisplay(project.path, homeDirectory)}
                  </span>
                  {isCurrent ? <Icon name="check" className="size-3.5 shrink-0 text-primary" aria-label={t('sessions.moveSession.current')} /> : null}
                </button>
              );
            })}
            {/* VS Code's projects are the workspace folders, which only opening one adds to. */}
            {isVSCodeRuntime() ? null : (
              <button type="button" className={ROW_CLASS} onClick={() => setChoosingFolder(true)}>
                <Icon name="folder-add" className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate typography-ui-label text-foreground">{t('sessions.moveSession.chooseFolder')}</span>
              </button>
            )}
          </ScrollableOverlay>
        </DialogContent>
      </Dialog>
      {choosingFolder ? (
        <DirectoryExplorerDialog
          open
          onOpenChange={setChoosingFolder}
          onProjectAdded={(project) => {
            setChoosingFolder(false);
            moveTo(project.path);
          }}
        />
      ) : null}
    </>
  );
};
