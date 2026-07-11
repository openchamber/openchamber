import React from 'react';
import { useDaytonaSandboxStore } from '@/stores/useDaytonaSandboxStore';
import { destroyDaytonaSandbox, listActiveSandboxes } from '@/lib/daytona/api';
import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/utils';
import { toast } from '@/components/ui';

export const DaytonaSettingsSection: React.FC = () => {
  const sandboxMode = useDaytonaSandboxStore((state) => state.sandboxMode);
  const setSandboxMode = useDaytonaSandboxStore((state) => state.setSandboxMode);
  const sandboxes = useDaytonaSandboxStore((state) => state.sandboxes);
  const removeSandbox = useDaytonaSandboxStore((state) => state.removeSandbox);
  const setSandboxStatus = useDaytonaSandboxStore((state) => state.setSandboxStatus);

  const [isDestroyingAll, setIsDestroyingAll] = React.useState(false);
  const [isRefreshing, setIsRefreshing] = React.useState(false);

  const activeSandboxes = React.useMemo(() => {
    const result: Array<{ sessionId: string; status: string; createdAt: string }> = [];
    sandboxes.forEach((info, sessionId) => {
      if (info.status !== 'destroyed') {
        result.push({ sessionId, status: info.status, createdAt: info.createdAt });
      }
    });
    return result;
  }, [sandboxes]);

  const handleRefresh = React.useCallback(async () => {
    setIsRefreshing(true);
    try {
      const list = await listActiveSandboxes();
      for (const info of list) {
        setSandboxStatus(info.sessionId, info);
      }
    } catch (error) {
      console.warn('[daytona] Failed to refresh sandboxes:', error);
    } finally {
      setIsRefreshing(false);
    }
  }, [setSandboxStatus]);

  const handleDestroyAll = React.useCallback(async () => {
    setIsDestroyingAll(true);
    const sessionIds = Array.from(sandboxes.keys()).filter((id) => {
      const info = sandboxes.get(id);
      return info && info.status !== 'destroyed' && info.status !== 'stopping';
    });

    const results = await Promise.allSettled(
      sessionIds.map(async (sessionId) => {
        setSandboxStatus(sessionId, { status: 'stopping' });
        await destroyDaytonaSandbox(sessionId);
        removeSandbox(sessionId);
      }),
    );

    const failures = results.filter((r) => r.status === 'rejected');
    if (failures.length > 0) {
      toast.error('Failed to destroy some sandboxes', {
        description: `${failures.length} of ${sessionIds.length} sandboxes could not be destroyed.`,
      });
    } else if (sessionIds.length > 0) {
      toast.success(`Destroyed ${sessionIds.length} sandbox${sessionIds.length > 1 ? 'es' : ''}`);
    }

    setIsDestroyingAll(false);
  }, [sandboxes, setSandboxStatus, removeSandbox]);

  return (
    <div className="mb-6">
      <div className="mb-0.5 px-1">
        <div className="flex items-center gap-2">
          <h3 className="typography-ui-header font-medium text-foreground">Daytona Sandboxes</h3>
        </div>
      </div>

      <section className="px-2 pb-2 pt-0 space-y-2">
        <div className="mt-0 mb-1 typography-meta text-muted-foreground">
          Each chat session runs in an isolated Daytona sandbox container.
          Code generation and modifications happen inside the sandbox.
          Sandboxes are automatically destroyed after 10 minutes of inactivity.
        </div>

        <div
          className="group flex cursor-pointer items-center gap-2 py-1"
          role="button"
          tabIndex={0}
          aria-pressed={sandboxMode}
          onClick={() => setSandboxMode(!sandboxMode)}
          onKeyDown={(event) => {
            if (event.key === ' ' || event.key === 'Enter') {
              event.preventDefault();
              setSandboxMode(!sandboxMode);
            }
          }}
        >
          <Checkbox
            checked={sandboxMode}
            onChange={setSandboxMode}
            ariaLabel="Enable sandbox mode"
          />
          <span className="typography-ui-label text-foreground">
            Enable sandbox mode
          </span>
        </div>

        {sandboxMode && (
          <>
            <div className="flex items-center gap-2 pt-2">
              <h4 className="typography-ui-label font-medium text-foreground">
                Active Sandboxes ({activeSandboxes.length})
              </h4>
              <button
                type="button"
                className={cn(
                  'typography-meta text-muted-foreground hover:text-foreground transition-colors',
                  isRefreshing && 'opacity-50 pointer-events-none',
                )}
                onClick={handleRefresh}
                disabled={isRefreshing}
              >
                {isRefreshing ? 'Refreshing...' : 'Refresh'}
              </button>
            </div>

            {activeSandboxes.length > 0 ? (
              <div className="space-y-1">
                {activeSandboxes.map(({ sessionId, status, createdAt }) => (
                  <div
                    key={sessionId}
                    className="flex items-center justify-between gap-2 rounded px-2 py-1 bg-muted/30"
                  >
                    <div className="min-w-0 flex-1">
                      <span className="typography-meta text-foreground truncate block">
                        {sessionId.slice(0, 12)}...
                      </span>
                      <span className="typography-meta text-muted-foreground">
                        {status} - {new Date(createdAt).toLocaleTimeString()}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="typography-meta text-muted-foreground py-1">
                No active sandboxes
              </div>
            )}

            {activeSandboxes.length > 0 && (
              <button
                type="button"
                className={cn(
                  'mt-2 rounded px-3 py-1.5 typography-ui-label',
                  'bg-destructive/10 text-destructive hover:bg-destructive/20 transition-colors',
                  isDestroyingAll && 'opacity-50 pointer-events-none',
                )}
                onClick={handleDestroyAll}
                disabled={isDestroyingAll}
              >
                {isDestroyingAll ? 'Destroying...' : 'Destroy All Sandboxes'}
              </button>
            )}
          </>
        )}
      </section>
    </div>
  );
};
