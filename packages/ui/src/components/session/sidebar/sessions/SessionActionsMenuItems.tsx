import React from 'react';
import { toast } from '@/components/ui';
import { Icon } from '@/components/icon/Icon';
import { ArrowsMerge } from '@/components/icons/ArrowsMerge';
import { GuestIcon } from '@/components/layout/GuestRailIcon';
import { SessionAiRenameMenuItem } from '@/components/session/SessionAiRenameMenuItem';
import { SessionReadMenuItem } from '@/components/session/SessionReadMenuItem';
import { openSessionInSidePanel } from '@/components/session/sessionSidePanel';
import { useGuestActions } from '@/hooks/useGuestSurfaces';
import { copyTextToClipboard } from '@/lib/clipboard';
import { canUseElectronDesktopIPC, getMiniChatRuntimeArgs, invokeDesktop, isVSCodeRuntime } from '@/lib/desktop';
import { guestSessionActions, type GuestActionEntry } from '@/lib/guests/actions';
import { runGuestSessionAction } from '@/lib/guests/session-action';
import { getChatsRootFromDirectory } from '@/lib/chatDirectories';
import { useI18n } from '@/lib/i18n';
import { getMultiRunIdentity } from '@/lib/multirun/identity';
import { useMultiRunMemberIds } from '@/lib/multirun/useMultiRuns';
import type { Session } from '@/lib/opencode/model';
import { getSessionPinList } from '@/lib/sessionPins';
import { formatShortcutForDisplay, getEffectiveShortcutCombo } from '@/lib/shortcuts';
import { DEFAULT_PIN_LIST } from '@/lib/sidebarSections';
import { isSpaceDirectory } from '@/lib/spaces/space-route';
import { formatDirectoryName } from '@/lib/utils';
import {
  buildSessionTreeMoveMessages,
  requestSessionTreeMove,
  useIsSessionWorktreeMovePending,
} from '@/lib/worktrees/sessionWorktreeMove';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionFoldersStore } from '@/stores/useSessionFoldersStore';
import { useSessionWarmingStore, useSessionWarmUntil } from '@/stores/useSessionWarmingStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionTurnActivity } from '@/sync/global-session-status';
import { setSessionPinList } from '@/sync/session-pins';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSessionMessageRecordsForExport } from '@/sync/use-sync';
import type { WorktreeMetadata } from '@/types/worktree';
import { SessionMenuItemHint } from '../../SessionMenuItemHint';
import type { SessionMenuSlots } from './sessionMenuSlots';
import { requestNewFolder } from '../folders/newFolderRequest';
import { PinToMenu } from '../sections/PinToMenu';
import {
  getSessionWorktreeMenuState,
  type SessionWorktreeMenuTarget,
  type StartSessionWorktreeMenuLoadArgs,
  type StartSessionWorktreeMenuLoadResult,
} from '../sessionWorktreeMenu';
import { normalizePath } from '../utils';
import { getWorkFolderScope } from './sessionFolderIdentity';
import { canShowSessionWorktreeMenu, getSessionWorktreeMenuDisabled } from './sessionNodeItemUtils';
import { collectSessionMoveDescendants } from './sessionSubtreeActions';

/** Track / Done for a session that is a work of its own. */
type SessionMenuWork = {
  inWork: boolean;
  toggle: () => void;
};

/** Where Move to folder files the session. */
export type SessionMenuFolders = {
  /** The row's folder owner: `work:<dir>` for a worktree or space, else the project's or Chats'. */
  ownerKey: string | null;
  projectId: string | null;
  /** Names the new folder in place in the list; without it a dialog asks for the name. */
  createInline?: (scope: string) => { id: string } | null;
};

type SessionActionsMenuItemsProps = {
  session: Session;
  directory: string | null;
  /** The menu is open; AI rename loads its eligibility only then. */
  open: boolean;
  slots: SessionMenuSlots;
  archived: boolean;
  pinned: boolean;
  /** Null when the session leaves Track / Done to the work it belongs to. */
  work: SessionMenuWork | null;
  /** The project Move to worktree lists the worktrees of. */
  projectId: string | null;
  currentWorktree: WorktreeMetadata | null;
  /** Subsessions the surface already shows; a move takes them along. */
  descendants: readonly Session[];
  startWorktreeLoad: ((args: StartSessionWorktreeMenuLoadArgs) => StartSessionWorktreeMenuLoadResult) | null;
  /** Null when the surface may not file this session in a folder. */
  folders: SessionMenuFolders | null;
  /** Touch menus leave out keyboard hints. */
  touch?: boolean;
  onRename: () => void;
  onExport: () => void;
  onMoveSession: () => void;
  onArchive: () => void;
  /** Null when the session cannot come back on its own. */
  onRestore: (() => void) | null;
  onDelete: () => void;
};

/**
 * Every action on one session, the same in the sidebar row's menu and in the
 * header's session menus. Each surface supplies what only it knows (rename in
 * place, its dialogs, where the session sits) and the menu primitives it opens in.
 */
export function SessionActionsMenuItems({
  session,
  directory,
  open,
  slots,
  archived,
  pinned,
  work,
  projectId,
  currentWorktree,
  descendants,
  startWorktreeLoad,
  folders,
  touch = false,
  onRename,
  onExport,
  onMoveSession,
  onArchive,
  onRestore,
  onDelete,
}: SessionActionsMenuItemsProps): React.ReactNode {
  const { Item, Separator, Sub, SubTrigger, SubContent } = slots;
  const { t } = useI18n();
  const isVSCode = React.useMemo(() => isVSCodeRuntime(), []);
  const isElectron = React.useMemo(() => canUseElectronDesktopIPC(), []);
  const sessionTitle = session.title || t('sessions.sidebar.session.untitled');
  const isSubtaskSession = Boolean(session.parentID);
  const isCurrentSession = useSessionUIStore((state) => state.currentSessionId === session.id);
  const shortcutOverrides = useUIStore((state) => state.shortcutOverrides);
  const renameShortcut = formatShortcutForDisplay(getEffectiveShortcutCombo('rename_current_session', shortcutOverrides), '');
  const archiveShortcut = formatShortcutForDisplay(getEffectiveShortcutCombo('archive_current_session', shortcutOverrides), '');
  const isStreaming = useSessionTurnActivity(session.id) !== null;
  const isMovingToWorktree = useIsSessionWorktreeMovePending(session.id);
  // Keep leaves one survivor that still carries its run marker; the overview
  // has no run to show for it, so the item goes with the run.
  const inLiveRun = useMultiRunMemberIds(session.id).length > 0;
  const multiRunKey = React.useMemo(() => (inLiveRun ? getMultiRunIdentity(session)?.key ?? null : null), [inLiveRun, session]);

  // Per-session warming is offered only while Settings chose it, for a root
  // session the host's OpenCode runs (a space's sessions run on its own).
  const perSessionWarming = useSessionWarmingStore((state) => state.enabled);
  const isWarmed = useSessionWarmUntil(session.id) !== undefined;
  const canKeepWarm = perSessionWarming && !archived && !isSubtaskSession
    && Boolean(directory) && !isSpaceDirectory(directory);
  const toggleSessionWarm = async () => {
    if (!directory) return;
    try {
      await useSessionWarmingStore.getState().setSessionWarm(session.id, directory, !isWarmed);
    } catch {
      toast.error(t('sessions.warming.toggleFailed'));
    }
  };

  const copySessionId = () => {
    void copyTextToClipboard(session.id)
      .then((result) => {
        toast[result.ok ? 'success' : 'error'](t(result.ok
          ? 'sessions.sidebar.session.copyId.success'
          : 'sessions.sidebar.session.copyId.error'));
      })
      .catch(() => toast.error(t('sessions.sidebar.session.copyId.error')));
  };

  const loadExportRecords = useSessionMessageRecordsForExport();
  const guestActionEntries = useGuestActions();
  const guestSessionActionEntries = React.useMemo(() => guestSessionActions(guestActionEntries), [guestActionEntries]);
  const runGuestAction = (entry: GuestActionEntry) => {
    void runGuestSessionAction({
      entry,
      t,
      session: { id: session.id, title: session.title, directory },
      loadRecords: () => (directory
        ? loadExportRecords({ directory, sessionID: session.id }).catch(() => null)
        : Promise.resolve(null)),
      onLoadFailed: () => toast.error(t('sessions.sidebar.session.export.failedLoadHistory')),
    });
  };

  const openMiniChatWindow = () => {
    if (!directory) return;
    void invokeDesktop('desktop_open_session_mini_chat_window', {
      sessionId: session.id,
      directory,
      ...getMiniChatRuntimeArgs(),
    }).catch((error) => {
      console.warn('[session-menu] failed to open mini chat window', error);
    });
  };

  const [worktreeTargets, setWorktreeTargets] = React.useState<SessionWorktreeMenuTarget[]>([]);
  const [worktreeTargetsLoadFailed, setWorktreeTargetsLoadFailed] = React.useState(false);
  const worktreeSubmenuOpenRef = React.useRef(false);
  const worktreeLoadSequenceRef = React.useRef(0);
  const handleWorktreeSubmenuOpenChange = (submenuOpen: boolean) => {
    worktreeSubmenuOpenRef.current = submenuOpen;
    worktreeLoadSequenceRef.current += 1;
    const loadSequence = worktreeLoadSequenceRef.current;
    if (!submenuOpen || !startWorktreeLoad) {
      setWorktreeTargetsLoadFailed(false);
      return;
    }
    const load = startWorktreeLoad({ projectId, sourceDirectory: directory, currentWorktree });
    setWorktreeTargets(load.cachedTargets);
    setWorktreeTargetsLoadFailed(false);
    void load.refreshTargets
      .then((freshTargets) => {
        if (!worktreeSubmenuOpenRef.current || worktreeLoadSequenceRef.current !== loadSequence) return;
        setWorktreeTargets(freshTargets);
        setWorktreeTargetsLoadFailed(false);
      })
      .catch(() => {
        if (!worktreeSubmenuOpenRef.current || worktreeLoadSequenceRef.current !== loadSequence) return;
        setWorktreeTargetsLoadFailed(true);
      });
  };

  const getFoldersForScope = useSessionFoldersStore((state) => state.getFoldersForScope);
  const getSessionFolderId = useSessionFoldersStore((state) => state.getSessionFolderId);
  const removeSessionFromFolder = useSessionFoldersStore((state) => state.removeSessionFromFolder);
  const addSessionToFolder = useSessionFoldersStore((state) => state.addSessionToFolder);

  const renderMoveMenu = (canMoveToProject: boolean) => {
    const isWorktreeMenuDisabled = getSessionWorktreeMenuDisabled({ sessionDirectory: directory, isStreaming, isMovingToWorktree });
    const worktreeMenuState = getSessionWorktreeMenuState({ targets: worktreeTargets, loadFailed: worktreeTargetsLoadFailed });
    const worktreeSubTrigger = (
      <SubTrigger
        disabled={isWorktreeMenuDisabled}
        className="w-full [&>svg]:me-1"
        data-session-worktree-submenu-trigger={session.id}
      >
        <Icon name="folder-shared" className="me-1 h-4 w-4" />
        {t('sessions.sidebar.session.menu.moveTo')}
      </SubTrigger>
    );
    // Only a disabled item explains itself: an enabled one opens the
    // worktree list, which the hint would cover.
    const worktreeMenuHint = isMovingToWorktree
      ? t('sessions.sidebar.session.moveToWorktree.tooltipMoving')
      : isStreaming
        ? t('sessions.sidebar.session.moveToWorktree.tooltipBusy')
        : null;
    const moveTree = (request: { kind: 'existing'; destination: WorktreeMetadata } | { kind: 'quick' }) => {
      if (!directory) return;
      const common = {
        root: session,
        descendants: collectSessionMoveDescendants(session, descendants),
        sourceDirectory: directory,
      };
      if (request.kind === 'existing') {
        requestSessionTreeMove({
          ...common,
          kind: 'existing',
          destination: request.destination,
          messages: buildSessionTreeMoveMessages(t, {
            success: 'sessions.sidebar.session.moveToWorktree.existingSuccess',
            failure: 'sessions.sidebar.session.moveToWorktree.existingFailed',
          }),
        });
        return;
      }
      requestSessionTreeMove({
        ...common,
        kind: 'quick',
        messages: buildSessionTreeMoveMessages(t, {
          success: 'sessions.sidebar.session.moveToWorktree.success',
          failure: 'sessions.sidebar.session.moveToWorktree.failed',
        }),
      });
    };
    return (
      <Sub onOpenChange={handleWorktreeSubmenuOpenChange}>
        {worktreeMenuHint
          ? <SessionMenuItemHint hint={worktreeMenuHint}>{worktreeSubTrigger}</SessionMenuItemHint>
          : worktreeSubTrigger}
        <SubContent className="min-w-[220px]" data-session-worktree-submenu={session.id}>
          {canMoveToProject ? <>
            <SessionMenuItemHint hint={t('sessions.moveSession.hint')}>
              <Item onClick={onMoveSession} className="[&>svg]:me-1">
                <Icon name="folder-received" className="me-1 h-4 w-4" />
                {t('sessions.sidebar.session.menu.moveToAnotherProject')}
              </Item>
            </SessionMenuItemHint>
            <Separator />
          </> : null}
          {worktreeTargets.map((target) => {
            const targetPath = normalizePath(target.metadata.path ?? null) ?? target.metadata.path;
            const itemLabel = target.isPrimary
              ? t('sessions.sidebar.session.moveToWorktree.main')
              : (target.metadata.label || target.metadata.branch || target.metadata.name || target.metadata.path);
            const isDisabled = target.isCurrent || target.metadata.worktreeStatus !== 'ready';
            return (
              <Item
                key={targetPath}
                disabled={isDisabled}
                title={target.metadata.path}
                data-session-worktree-target={targetPath}
                onClick={() => {
                  if (isDisabled) return;
                  moveTree({ kind: 'existing', destination: target.metadata });
                }}
              >
                <span className="flex min-w-0 flex-1 items-center gap-1 truncate">
                  <span className="truncate">{itemLabel}</span>
                  {target.isCurrent ? <span className="sr-only">{t('sessions.sidebar.session.moveToWorktree.current')}</span> : null}
                </span>
                {target.isCurrent ? <Icon name="check" className="ms-2 h-3.5 w-3.5 flex-shrink-0 text-primary" aria-hidden="true" /> : null}
              </Item>
            );
          })}
          {worktreeMenuState.refreshState === 'error' ? (
            <Item disabled data-session-worktree-refresh-state="error" className="py-0.5 text-muted-foreground typography-micro">
              {t('sessions.sidebar.session.moveToWorktree.loadFailed')}
            </Item>
          ) : null}
          <Separator />
          {worktreeMenuState.showNewWorktreeAction ? (
            <Item
              disabled={isWorktreeMenuDisabled}
              data-session-worktree-new-action="true"
              onClick={() => {
                if (!isWorktreeMenuDisabled) moveTree({ kind: 'quick' });
              }}
              className="[&>svg]:me-1"
            >
              <Icon name="add" className="me-1 h-4 w-4" />
              {t('sessions.sidebar.session.menu.newWorktree')}
            </Item>
          ) : null}
        </SubContent>
      </Sub>
    );
  };

  const renderFolderMenu = (placement: SessionMenuFolders, sessionDirectory: string) => {
    // A session files where its row lives: the project root's folders, or
    // those of its own worktree, which itself files whole. Every other
    // scope is read only to find and clear an older membership.
    const workScope = getWorkFolderScope(placement.ownerKey);
    const scopes: string[] = [];
    const pushScope = (candidate: string | null | undefined) => {
      const normalized = normalizePath(candidate ?? null);
      if (normalized && !scopes.includes(normalized)) scopes.push(normalized);
    };
    const project = placement.projectId && !isVSCode
      ? useProjectsStore.getState().projects.find((entry) => entry.id === placement.projectId)
      : undefined;
    const projectRoot = normalizePath(project?.path ?? null);
    if (workScope) pushScope(workScope);
    else if (projectRoot) pushScope(projectRoot);
    else {
      pushScope(getChatsRootFromDirectory(sessionDirectory));
      pushScope(sessionDirectory);
    }
    const offeredScopes = [...scopes];
    pushScope(projectRoot);
    pushScope(sessionDirectory);
    if (projectRoot) {
      (useSessionUIStore.getState().availableWorktreesByProject.get(projectRoot) ?? [])
        .forEach((worktree) => pushScope(worktree.path));
    }
    const allEntries = scopes.flatMap((scope) =>
      getFoldersForScope(scope).map((folder) => ({ scope, folder })));
    const currentEntry = allEntries.find(({ scope, folder }) =>
      getSessionFolderId(scope, session.id) === folder.id) ?? null;
    const folderEntries = allEntries.filter((entry) => offeredScopes.includes(entry.scope) || entry === currentEntry);
    const defaultScope = offeredScopes[0] ?? sessionDirectory;
    const fileInNewFolder = (folderId: string): void => {
      for (const scope of scopes) {
        if (scope !== defaultScope) removeSessionFromFolder(scope, session.id);
      }
      addSessionToFolder(defaultScope, folderId, session.id);
    };
    if (workScope && folderEntries.length === 0) return null;
    return (
      <>
        <Sub>
          <SessionMenuItemHint hint={t('sessions.sidebar.session.menuHint.moveToFolder')}>
            <SubTrigger className="[&>svg]:me-1"><Icon name="folder" className="h-4 w-4" />{t('sessions.sidebar.folders.moveToFolder')}</SubTrigger>
          </SessionMenuItemHint>
          <SubContent className="min-w-[180px]">
            {folderEntries.length === 0 ? (
              <Item disabled className="text-muted-foreground">{t('sessions.sidebar.folders.none')}</Item>
            ) : (
              folderEntries.map(({ scope, folder }) => {
                const isCurrent = currentEntry?.folder.id === folder.id;
                return (
                  <Item key={folder.id} onClick={() => {
                    if (isCurrent) {
                      removeSessionFromFolder(scope, session.id);
                      return;
                    }
                    for (const candidateScope of scopes) {
                      if (candidateScope !== scope) removeSessionFromFolder(candidateScope, session.id);
                    }
                    addSessionToFolder(scope, folder.id, session.id);
                  }}>
                    <span dir="auto" className="oc-ui-start-align flex-1 truncate">{folder.name}</span>
                    {isCurrent ? <Icon name="check" className="ms-2 h-3.5 w-3.5 text-primary flex-shrink-0" /> : null}
                  </Item>
                );
              })
            )}
            {!workScope ? <>
              <Separator />
              <Item onClick={() => {
                if (!placement.createInline) {
                  requestNewFolder({
                    projectLabel: project?.label?.trim() || (project ? formatDirectoryName(project.path, null) : null),
                    create: (name) => fileInNewFolder(useSessionFoldersStore.getState().createFolder(defaultScope, name).id),
                  });
                  return;
                }
                const newFolder = placement.createInline(defaultScope);
                if (newFolder) fileInNewFolder(newFolder.id);
              }}>
                <Icon name="add" className="me-1 h-4 w-4" />
                {t('sessions.sidebar.folders.newFolderEllipsis')}
              </Item>
            </> : null}
            {currentEntry ? (
              <Item onClick={() => { removeSessionFromFolder(currentEntry.scope, session.id); }} className="text-destructive focus:text-destructive">
                <Icon name="close" className="me-1 h-4 w-4" />
                {t('sessions.sidebar.folders.removeFromFolder')}
              </Item>
            ) : null}
          </SubContent>
        </Sub>
      </>
    );
  };

  const canMoveToWorktree = Boolean(startWorktreeLoad)
    && canShowSessionWorktreeMenu({ isSubtaskSession, archivedBucket: archived, isVSCode, sessionDirectory: directory });
  const canMoveToProject = !isSubtaskSession && !archived && !isVSCode && Boolean(directory) && !isSpaceDirectory(directory);

  // Where else the session opens. Two or more share one submenu; a lone one
  // stays a plain item, since a submenu of one only adds a hover.
  const openTargets = [
    !isVSCode ? {
      key: 'side-panel',
      icon: <Icon name="chat-4" className="me-1 h-4 w-4" />,
      label: t('sessions.sidebar.session.menu.openInSidePanel'),
      targetLabel: t('sessions.sidebar.session.menu.openInSidePanelTarget'),
      hint: t('sessions.sidebar.session.menuHint.openInSidePanel'),
      disabled: !directory,
      run: () => { if (directory) openSessionInSidePanel(session.id, directory, sessionTitle); },
    } : null,
    isElectron ? {
      key: 'mini-chat',
      icon: <Icon name="picture-in-picture-2" className="me-1 h-4 w-4" />,
      label: t('sessions.sidebar.session.menu.openMiniChatWindow'),
      targetLabel: t('sessions.sidebar.session.menu.openInMiniChatTarget'),
      hint: t('sessions.sidebar.session.menuHint.openMiniChatWindow'),
      disabled: !directory,
      run: openMiniChatWindow,
    } : null,
    multiRunKey ? {
      key: 'run-overview',
      icon: <ArrowsMerge className="me-1 h-4 w-4" />,
      label: t('sessions.sidebar.session.menu.openRunOverview'),
      targetLabel: t('sessions.sidebar.session.menu.openInRunOverviewTarget'),
      hint: t('sessions.sidebar.session.menuHint.openRunOverview'),
      disabled: false,
      run: () => useUIStore.getState().setRunOverviewKey(multiRunKey),
    } : null,
  ].filter((target) => target !== null);
  const renderOpenTarget = (target: (typeof openTargets)[number], inSubmenu: boolean) => (
    <SessionMenuItemHint key={target.key} hint={target.hint}>
      <Item disabled={target.disabled} onClick={target.run} className="[&>svg]:me-1">
        {target.icon}
        <span className="truncate">{inSubmenu ? target.targetLabel : target.label}</span>
      </Item>
    </SessionMenuItemHint>
  );

  const exportMarkdownItem = (inSubmenu: boolean) => (
    <SessionMenuItemHint hint={t('sessions.sidebar.session.menuHint.exportMarkdown')}>
      <Item onClick={onExport} className="[&>svg]:me-1">
        <Icon name="download" className="me-1 h-4 w-4" />
        {inSubmenu ? t('sessions.sidebar.session.menu.exportMarkdownFile') : t('sessions.sidebar.session.menu.exportMarkdown')}
      </Item>
    </SessionMenuItemHint>
  );

  return (
    <>
      {openTargets.length > 1 ? (
        <Sub>
          <SubTrigger className="[&>svg]:me-1">
            <Icon name="external-link" className="me-1 h-4 w-4" />
            {t('sessions.sidebar.session.menu.openIn')}
          </SubTrigger>
          <SubContent className="min-w-[180px]">
            {openTargets.map((target) => renderOpenTarget(target, true))}
          </SubContent>
        </Sub>
      ) : openTargets.map((target) => renderOpenTarget(target, false))}
      {openTargets.length > 0 ? <Separator /> : null}

      <SessionMenuItemHint hint={t('sessions.sidebar.session.menuHint.rename')}>
        <Item onClick={onRename} className="[&>svg]:me-1">
          <Icon name="pencil-ai" className="me-1 h-4 w-4" />
          {t('sessions.sidebar.session.menu.rename')}
          {isCurrentSession && renameShortcut ? <span className="ms-auto ps-3 typography-meta text-muted-foreground">{renameShortcut}</span> : null}
        </Item>
      </SessionMenuItemHint>
      <SessionAiRenameMenuItem sessionID={session.id} directory={directory} open={open} Item={Item} />
      <Separator />

      {work ? (
        <SessionMenuItemHint hint={work.inWork ? t('sessions.sidebar.session.menuHint.markDone') : t('sessions.sidebar.session.menuHint.track')}>
          <Item onClick={work.toggle} className="[&>svg]:me-1">
            <Icon name={work.inWork ? 'check' : 'eye'} className="me-1 h-4 w-4" />
            {work.inWork ? t('sessions.sidebar.session.work.markDone') : t('sessions.sidebar.session.work.track')}
          </Item>
        </SessionMenuItemHint>
      ) : null}
      <PinToMenu
        slots={slots}
        current={pinned ? getSessionPinList(session) ?? DEFAULT_PIN_LIST : null}
        triggerClassName="[&>svg]:me-1"
        itemClassName="[&>svg]:me-1"
        onPin={(list) => {
          if (!directory) return;
          setSessionPinList({ directory, sessionId: session.id }, true, list)
            .catch(() => toast.error(t('sessions.sidebar.session.pin.pinFailed')));
        }}
        onUnpin={() => {
          if (!directory) return;
          setSessionPinList({ directory, sessionId: session.id }, false, null)
            .catch(() => toast.error(t('sessions.sidebar.session.pin.unpinFailed')));
        }}
      />
      {directory && !archived && folders ? renderFolderMenu(folders, directory) : null}
      <SessionReadMenuItem sessionId={session.id} Item={Item} className="[&>svg]:me-1" iconClassName="me-1 h-4 w-4" showShortcut={!touch} />
      {canKeepWarm ? (
        <SessionMenuItemHint hint={isWarmed ? t('sessions.sidebar.session.menuHint.stopWarm') : t('sessions.sidebar.session.menuHint.keepWarm')}>
          <Item onClick={() => { void toggleSessionWarm(); }} className="[&>svg]:me-1">
            <Icon name={isWarmed ? 'fire-fill' : 'fire'} className="me-1 h-4 w-4" />
            {isWarmed ? t('sessions.sidebar.session.menu.stopWarm') : t('sessions.sidebar.session.menu.keepWarm')}
          </Item>
        </SessionMenuItemHint>
      ) : null}
      {canMoveToWorktree ? renderMoveMenu(canMoveToProject) : canMoveToProject ? (
        // Without worktrees to list (Chats), moving to another project is the
        // only move, and a submenu of one only adds a hover.
        <SessionMenuItemHint hint={isStreaming ? t('sessions.sidebar.session.moveToWorktree.tooltipBusy') : t('sessions.moveSession.hint')}>
          <span className="block">
            <Item disabled={isStreaming || isMovingToWorktree} onClick={onMoveSession} className="w-full [&>svg]:me-1">
              <Icon name="folder-received" className="me-1 h-4 w-4" />
              {t('sessions.moveSession.menu')}
            </Item>
          </span>
        </SessionMenuItemHint>
      ) : null}
      <Separator />

      {guestSessionActionEntries.length > 0 ? (
        <Sub>
          <SubTrigger className="[&>svg]:me-1">
            <Icon name="download" className="me-1 h-4 w-4" />
            {t('sessions.sidebar.session.menu.export')}
          </SubTrigger>
          <SubContent className="min-w-[180px]">
            {exportMarkdownItem(true)}
            {guestSessionActionEntries.map((entry) => (
              <Item key={`${entry.guest.id}:${entry.action.id}`} onClick={() => runGuestAction(entry)} className="[&>svg]:me-1">
                <GuestIcon icon={entry.icon} iconSrc={entry.iconSrc} className="me-1 size-4" />
                {entry.action.label}
              </Item>
            ))}
          </SubContent>
        </Sub>
      ) : exportMarkdownItem(false)}
      <SessionMenuItemHint hint={t('sessions.sidebar.session.menuHint.copyId')}>
        <Item onClick={copySessionId} className="[&>svg]:me-1">
          <Icon name="file-copy" className="me-1 h-4 w-4" />
          {t('sessions.sidebar.session.menu.copyId')}
        </Item>
      </SessionMenuItemHint>
      <Separator />

      {!archived ? (
        <SessionMenuItemHint hint={t('sessions.sidebar.session.menuHint.archive')}>
          <Item className="[&>svg]:me-1" onClick={onArchive}>
            <Icon name="inbox-archive" className="me-1 h-4 w-4" />
            {t('sessions.sidebar.bulkActions.archive')}
            {isCurrentSession && archiveShortcut ? <span className="ms-auto ps-3 typography-meta text-muted-foreground">{archiveShortcut}</span> : null}
          </Item>
        </SessionMenuItemHint>
      ) : null}
      {archived && onRestore ? (
        <SessionMenuItemHint hint={t('sessions.sidebar.session.menuHint.restore')}>
          <Item className="[&>svg]:me-1" onClick={onRestore}>
            <Icon name="inbox-unarchive" className="me-1 h-4 w-4" />
            {t('sessions.sidebar.bulkActions.restore')}
          </Item>
        </SessionMenuItemHint>
      ) : null}
      <SessionMenuItemHint hint={t('sessions.sidebar.session.menuHint.delete')}>
        <Item className="text-destructive focus:text-destructive [&>svg]:me-1" onClick={onDelete}>
          <Icon name="delete-bin" className="me-1 h-4 w-4" />
          {t('sessions.sidebar.bulkActions.delete')}
        </Item>
      </SessionMenuItemHint>
    </>
  );
}
