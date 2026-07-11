import React from 'react';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { copyTextToClipboard } from '@/lib/clipboard';
import { cn } from '@/lib/utils';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { useAgentGroupsStore, type AgentGroup, type AgentGroupSession } from '@/stores/useAgentGroupsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useGlobalSessionStatus, useAllSessionStatuses } from '@/sync/sync-context';
import { ChatContainer } from '@/components/chat/ChatContainer';
import { ChatErrorBoundary } from '@/components/chat/ChatErrorBoundary';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Icon } from "@/components/icon/Icon";
import { useI18n } from '@/lib/i18n';

interface AgentGroupDetailProps {
  group: AgentGroup;
  className?: string;
}

const SessionStatusDot: React.FC<{ sessionId: string }> = ({ sessionId }) => {
  const status = useGlobalSessionStatus(sessionId);
  if (!status || status.type === 'idle') return null;
  return (
    <span className="relative flex h-2 w-2 flex-shrink-0" title={status.type}>
      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75" />
      <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-500" />
    </span>
  );
};

export const AgentGroupDetail: React.FC<AgentGroupDetailProps> = ({
  group,
  className,
}) => {
  const { t } = useI18n();
  const selectedSessionId = useAgentGroupsStore((s) => s.selectedSessionId);
  const selectSession = useAgentGroupsStore((s) => s.selectSession);
  const deleteGroupSessions = useAgentGroupsStore((s) => s.deleteGroupSessions);
  const setCurrentSession = useSessionUIStore((s) => s.setCurrentSession);
  const currentSessionId = useSessionUIStore((s) => s.currentSessionId);
  const [worktreeDialog, setWorktreeDialog] = React.useState<null | { kind: 'remove' | 'keepOnly'; path: string; label: string }>(null);
  const [isProcessing, setIsProcessing] = React.useState(false);

  const selectedSession = React.useMemo(() => {
    if (!selectedSessionId) return group.sessions[0] ?? null;
    return group.sessions.find((s) => s.id === selectedSessionId) ?? group.sessions[0] ?? null;
  }, [group.sessions, selectedSessionId]);

  const handleSessionSelect = React.useCallback((session: AgentGroupSession) => {
    selectSession(session.id);
    setCurrentSession(session.id, session.path);
  }, [selectSession, setCurrentSession]);

  // Auto-select first session when group changes and sync OpenCode session
  React.useEffect(() => {
    if (group.sessions.length > 0) {
      const session = selectedSessionId
        ? group.sessions.find((s) => s.id === selectedSessionId) ?? group.sessions[0]
        : group.sessions[0];

        if (session) {
          if (session.id !== currentSessionId) {
            setCurrentSession(session.id, session.path);
          }
          if (!selectedSessionId) {
            selectSession(session.id);
        }
      }
    }
  }, [group.name, group.sessions, selectedSessionId, currentSessionId, selectSession, setCurrentSession]);

  const isSessionSynced = selectedSession?.id === currentSessionId;

  const handleCopyWorktreePath = React.useCallback(() => {
    if (!selectedSession?.path) {
      toast.error(t('agentManager.detail.toast.noWorktreePath'));
      return;
    }
    void copyTextToClipboard(selectedSession.path).then((result) => {
      if (result.ok) {
        toast.success(t('agentManager.detail.toast.worktreePathCopied'));
        return;
      }
      toast.error(t('agentManager.detail.toast.failedToCopyPath'));
    });
  }, [selectedSession?.path, t]);

  const handleRemoveSelectedWorktree = React.useCallback(() => {
    if (!selectedSession) return;
    setWorktreeDialog({ kind: 'remove', path: selectedSession.path, label: selectedSession.displayLabel });
  }, [selectedSession]);

  const handleKeepOnlySelectedWorktree = React.useCallback(() => {
    if (!selectedSession) return;
    setWorktreeDialog({ kind: 'keepOnly', path: selectedSession.path, label: selectedSession.displayLabel });
  }, [selectedSession]);

  const handleConfirmWorktreeAction = React.useCallback(async () => {
    if (!worktreeDialog || isProcessing) return;
    setIsProcessing(true);
    try {
      const normalize = (v: string) => v.replace(/\\/g, '/').replace(/\/+$/, '') || v;
      const targetPath = normalize(worktreeDialog.path);
      let sessionsToDelete: AgentGroupSession[];

      if (worktreeDialog.kind === 'remove') {
        toast.info(t('agentManager.detail.toast.removingWorktree'));
        sessionsToDelete = group.sessions.filter((s) => normalize(s.path) === targetPath);
      } else {
        toast.info(t('agentManager.detail.toast.removingOtherWorktrees'));
        sessionsToDelete = group.sessions.filter((s) => normalize(s.path) !== targetPath);
      }

      const { failedIds, failedWorktreePaths } = await deleteGroupSessions(sessionsToDelete, { removeWorktrees: true });
      if (failedIds.length > 0 || failedWorktreePaths.length > 0) {
        toast.error(t('agentManager.detail.toast.failedToFullyRemoveWorktree'));
      } else {
        toast.success(
          worktreeDialog.kind === 'remove'
            ? t('agentManager.detail.toast.worktreeRemoved')
            : t('agentManager.detail.toast.otherWorktreesRemoved')
        );
      }
      setWorktreeDialog(null);
    } finally {
      setIsProcessing(false);
    }
  }, [deleteGroupSessions, group.sessions, isProcessing, t, worktreeDialog]);

  // Group-level status: show if any session is busy
  const allStatuses = useAllSessionStatuses();
  const groupBusy = React.useMemo(
    () => group.sessions.some((s) => allStatuses[s.id]?.type === 'busy'),
    [group.sessions, allStatuses],
  );

  return (
    <div className={cn('flex h-full flex-col bg-background', className)}>
      {/* Header */}
      <div className="flex-shrink-0 border-b border-border/30 px-4 py-3">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h1 className="typography-heading-lg text-foreground truncate">{group.name}</h1>
              {groupBusy && <Icon name="loader-4" className="h-4 w-4 animate-spin text-amber-500 flex-shrink-0" />}
            </div>
            <div className="flex items-center gap-2 mt-1 typography-meta text-muted-foreground">
              <span>
                {group.sessionCount === 1
                  ? t('agentManager.detail.header.modelCountSingle', { count: group.sessionCount })
                  : t('agentManager.detail.header.modelCountPlural', { count: group.sessionCount })}
              </span>
              <span>·</span>
              <span className="flex items-center gap-1">
                <Icon name="git-branch" className="h-3.5 w-3.5" />
                {selectedSession?.worktreeMetadata?.label || selectedSession?.branch || t('agentManager.detail.header.noBranch')}
              </span>
            </div>
          </div>
        </div>

        {/* Model Selector Dropdown */}
        {group.sessions.length > 0 && (
          <div className="mt-3 flex items-center gap-2">
            <div className="flex-1 min-w-0">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  className="w-full justify-between h-10 px-3"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    {selectedSession && (
                      <>
                        <ProviderLogo
                          providerId={selectedSession.providerId}
                          className="h-5 w-5 flex-shrink-0"
                        />
                        <span className="truncate typography-body">
                          {selectedSession.modelId}
                        </span>
                        {selectedSession.instanceNumber > 1 && (
                          <span className="typography-meta text-muted-foreground">
                            #{selectedSession.instanceNumber}
                          </span>
                        )}
                        <SessionStatusDot sessionId={selectedSession.id} />
                      </>
                    )}
                  </div>
                  <Icon name="arrow-down-s" className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-[var(--anchor-width)]">
                {group.sessions.map((session) => (
                  <DropdownMenuItem
                    key={session.id}
                    onClick={() => handleSessionSelect(session)}
                    className="flex items-center gap-2 py-2"
                  >
                    <ProviderLogo
                      providerId={session.providerId}
                      className="h-5 w-5 flex-shrink-0"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="truncate typography-body">
                          {session.modelId}
                        </span>
                        {session.instanceNumber > 1 && (
                          <span className="typography-meta text-muted-foreground">
                            #{session.instanceNumber}
                          </span>
                        )}
                        <SessionStatusDot sessionId={session.id} />
                      </div>
                      {session.branch && (
                        <div className="flex items-center gap-1 typography-micro text-muted-foreground/60">
                          <Icon name="git-branch" className="h-3 w-3" />
                          <span className="truncate">{session.worktreeMetadata?.label || session.branch}</span>
                        </div>
                      )}
                    </div>
                    {selectedSession?.id === session.id && (
                      <Icon name="check" className="h-4 w-4 text-primary flex-shrink-0" />
                    )}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            </div>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="icon" className="flex-shrink-0" aria-label={t('agentManager.detail.actions.worktreeActionsAria')}>
                  <Icon name="more-2" className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-[220px]">
                <DropdownMenuItem
                  onSelect={handleRemoveSelectedWorktree}
                  closeOnClick={false}
                  variant="destructive"
                >
                  {t('agentManager.detail.actions.removeThisWorktree')}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={handleKeepOnlySelectedWorktree}
                  closeOnClick={false}
                >
                  {t('agentManager.detail.actions.keepThisRemoveOthers')}
                </DropdownMenuItem>
                <DropdownMenuItem
                onClick={(e) => {
                  e.stopPropagation();
                  handleCopyWorktreePath();
                }}
                disabled={!selectedSession?.path}
              >
                <Icon name="file-copy" className="h-4 w-4 mr-px" />
                {t('agentManager.detail.actions.copyWorktreePath')}
              </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
      </div>

      <Dialog open={Boolean(worktreeDialog)} onOpenChange={(open) => { if (!open) setWorktreeDialog(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {worktreeDialog?.kind === 'remove'
                ? t('agentManager.detail.dialog.removeWorktreeTitle')
                : t('agentManager.detail.dialog.removeOtherWorktreesTitle')}
            </DialogTitle>
            <DialogDescription>
              {worktreeDialog?.kind === 'remove'
                ? t('agentManager.detail.dialog.removeWorktreeDescription', { label: worktreeDialog?.label ?? '' })
                : t('agentManager.detail.dialog.removeOtherWorktreesDescription', {
                    label: worktreeDialog?.label ?? '',
                    group: group.name,
                  })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setWorktreeDialog(null)} disabled={isProcessing}>
              {t('agentManager.detail.dialog.cancel')}
            </Button>
            <Button
              variant={worktreeDialog?.kind === 'remove' ? 'destructive' : 'default'}
              onClick={() => void handleConfirmWorktreeAction()}
              disabled={isProcessing}
            >
              {isProcessing
                ? t('agentManager.detail.dialog.working')
                : worktreeDialog?.kind === 'remove'
                  ? t('agentManager.detail.dialog.remove')
                  : t('agentManager.detail.dialog.removeOthers')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Chat Content */}
      <div className="flex-1 min-h-0">
        {selectedSession ? (
          isSessionSynced ? (
            <ChatErrorBoundary sessionId={selectedSession.id}>
              <ChatContainer />
            </ChatErrorBoundary>
          ) : (
            <div className="h-full flex flex-col">
              <div className="px-4 py-2 bg-muted/30 border-b border-border/30">
                <div className="flex items-center gap-2 typography-meta text-muted-foreground">
                  <ProviderLogo providerId={selectedSession.providerId} className="h-4 w-4" />
                  <span className="font-medium text-foreground">
                    {selectedSession.displayLabel}
                  </span>
                  <span>·</span>
                  <span className="font-mono text-xs truncate">
                    {selectedSession.path}
                  </span>
                </div>
              </div>
              <div className="flex-1 flex items-center justify-center">
                <div className="text-center p-8">
                  <p className="typography-body text-muted-foreground mb-2">
                    {t('agentManager.detail.state.loadingSessionFor', { label: selectedSession.displayLabel })}
                  </p>
                  <p className="typography-micro text-muted-foreground/60">
                    {t('agentManager.detail.state.sessionId', { id: selectedSession.id })}
                  </p>
                </div>
              </div>
            </div>
          )
        ) : (
          <div className="h-full flex items-center justify-center">
            <p className="typography-body text-muted-foreground">
              {t('agentManager.detail.state.noSessionsInGroup')}
            </p>
          </div>
        )}
      </div>
    </div>
  );
};
