import React from 'react';
import { toast } from '@/components/ui';
import { AgentManagerSidebar } from './AgentManagerSidebar';
import { AgentManagerEmptyState } from './AgentManagerEmptyState';
import { AgentGroupDetail } from './AgentGroupDetail';
import { cn } from '@/lib/utils';
import { useAgentGroupsStore } from '@/stores/useAgentGroupsStore';
import { useMultiRunStore } from '@/stores/useMultiRunStore';
import { useConfigStore } from '@/stores/useConfigStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import type { CreateMultiRunParams } from '@/types/multirun';

interface AgentManagerViewProps {
  className?: string;
}

export const AgentManagerView: React.FC<AgentManagerViewProps> = ({ className }) => {
  const isVSCodeRuntime = Boolean(
    (typeof window !== 'undefined'
      ? (window as unknown as { __OPENCHAMBER_RUNTIME_APIS__?: { runtime?: { isVSCode?: boolean } } })
          .__OPENCHAMBER_RUNTIME_APIS__?.runtime?.isVSCode
      : false)
  );
  const [connectionStatus, setConnectionStatus] = React.useState<'connecting' | 'connected' | 'error' | 'disconnected'>(
    () =>
      (typeof window !== 'undefined'
        ? (window as unknown as { __OPENCHAMBER_CONNECTION__?: { status?: string } }).__OPENCHAMBER_CONNECTION__?.status as
            'connecting' | 'connected' | 'error' | 'disconnected' | undefined
        : 'connecting') || 'connecting'
  );
  const configInitialized = useConfigStore((s) => s.isInitialized);
  const initializeApp = useConfigStore((s) => s.initializeApp);
  const setDirectory = useDirectoryStore((s) => s.setDirectory);
  const currentDirectory = useDirectoryStore((s) => s.currentDirectory);
  const bootstrapAttemptAt = React.useRef<number>(0);

  const groups = useAgentGroupsStore((s) => s.groups);
  const selectedGroupName = useAgentGroupsStore((s) => s.selectedGroupName);
  const selectGroup = useAgentGroupsStore((s) => s.selectGroup);
  const loadGroups = useAgentGroupsStore((s) => s.loadGroups);

  const createMultiRun = useMultiRunStore((s) => s.createMultiRun);
  const isCreatingMultiRun = useMultiRunStore((s) => s.isLoading);

  const selectedGroup = React.useMemo(
    () => (selectedGroupName ? groups.find((g) => g.name === selectedGroupName) ?? null : null),
    [groups, selectedGroupName],
  );

  // VS Code connection bootstrap
  React.useEffect(() => {
    if (!isVSCodeRuntime) return;

    const current =
      (typeof window !== 'undefined'
        ? (window as unknown as { __OPENCHAMBER_CONNECTION__?: { status?: string } }).__OPENCHAMBER_CONNECTION__?.status
        : undefined) as 'connecting' | 'connected' | 'error' | 'disconnected' | undefined;
    if (current) setConnectionStatus(current);

    const handler = (event: Event) => {
      const status = (event as CustomEvent<{ status?: string }>).detail?.status;
      if (status === 'connected' || status === 'connecting' || status === 'error' || status === 'disconnected') {
        setConnectionStatus(status);
      }
    };
    window.addEventListener('openchamber:connection-status', handler as EventListener);
    return () => window.removeEventListener('openchamber:connection-status', handler as EventListener);
  }, [isVSCodeRuntime]);

  React.useEffect(() => {
    if (!isVSCodeRuntime || connectionStatus !== 'connected') return;
    const now = Date.now();
    if (now - bootstrapAttemptAt.current < 750) return;
    bootstrapAttemptAt.current = now;

    const workspaceFolder = (typeof window !== 'undefined'
      ? (window as unknown as { __VSCODE_CONFIG__?: { workspaceFolder?: unknown } }).__VSCODE_CONFIG__?.workspaceFolder
      : null);

    if (typeof workspaceFolder === 'string' && workspaceFolder.trim().length > 0) {
      try { setDirectory(workspaceFolder, { showOverlay: false }); } catch { /* ignored */ }
    }

    if (!configInitialized) void initializeApp();
  }, [connectionStatus, configInitialized, initializeApp, isVSCodeRuntime, setDirectory]);

  // Load groups on mount and when directory changes
  React.useEffect(() => {
    void loadGroups();
  }, [currentDirectory, loadGroups]);

  const handleGroupSelect = React.useCallback((groupName: string) => {
    selectGroup(groupName);
  }, [selectGroup]);

  const handleNewAgent = React.useCallback(() => {
    selectGroup(null);
  }, [selectGroup]);

  const handleCreateGroup = React.useCallback(async (params: CreateMultiRunParams) => {
    toast.info(`Creating agent group "${params.name}" with ${params.models.length} model(s)...`);

    const result = await createMultiRun(params);

    if (result) {
      toast.success(`Agent group "${params.name}" created with ${result.sessionIds.length} session(s)`);
      // Refresh groups — new worktrees + sessions now exist
      await loadGroups();
      selectGroup(result.groupSlug);
    } else {
      const error = useMultiRunStore.getState().error;
      toast.error(error || 'Failed to create agent group');
    }
  }, [createMultiRun, loadGroups, selectGroup]);

  return (
    <div className={cn('flex h-full w-full bg-background', className)}>
      <div className="w-64 flex-shrink-0">
        <AgentManagerSidebar
          groups={groups}
          selectedGroupName={selectedGroupName}
          onGroupSelect={handleGroupSelect}
          onNewAgent={handleNewAgent}
        />
      </div>
      <div className="flex-1 min-w-0">
        {selectedGroup ? (
          <AgentGroupDetail group={selectedGroup} />
        ) : (
          <AgentManagerEmptyState
            onCreateGroup={handleCreateGroup}
            isCreating={isCreatingMultiRun}
          />
        )}
      </div>
    </div>
  );
};
