import React from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useI18n } from '@/lib/i18n';
import { isDisposableSideChat } from '@/lib/opencode/sideChatMetadata';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useDisposableSideChatsStore, type DisposableSideChatEntry } from '@/stores/useDisposableSideChatsStore';
import { getSessionContextPanelTabID, useUIStore } from '@/stores/useUIStore';
import { toast } from '@/components/ui';
import { closeDisposableSideChat, type DisposableSideChatIdentity } from './disposableSideChatLifecycle';
import { captureSideChatRuntimeOperation } from '@/lib/sideChats/runtimeOperation';
import { deleteSessionInCapturedRuntime } from '@/sync/session-actions';

const toIdentity = (entry: DisposableSideChatEntry): DisposableSideChatIdentity | null => entry.sideSessionId ? {
  runtimeKey: entry.runtimeKey,
  directory: entry.directory,
  parentSessionId: entry.parentSessionId,
  sideSessionId: entry.sideSessionId,
} : null;

export const DisposableSideChatRecoveryDialog: React.FC<{ enabled: boolean }> = ({ enabled }) => {
  const { t } = useI18n();
  const entries = useDisposableSideChatsStore((state) => state.entries);
  const [recoverable, setRecoverable] = React.useState<DisposableSideChatIdentity | null>(null);
  const [isWorking, setIsWorking] = React.useState(false);
  const handledKeysRef = React.useRef(new Set<string>());
  const recoveryGenerationRef = React.useRef('');

  React.useEffect(() => {
    if (!enabled || recoverable) return;
    const runtimeKey = getRuntimeKey();
    const storeGeneration = useDisposableSideChatsStore.getState().runtimeGeneration;
    const recoveryGeneration = `${runtimeKey}:${storeGeneration}`;
    if (recoveryGenerationRef.current !== recoveryGeneration) {
      recoveryGenerationRef.current = recoveryGeneration;
      handledKeysRef.current = new Set();
      setRecoverable(null);
    }
    const candidate = [...entries.entries()].find(([key, entry]) => (
      !handledKeysRef.current.has(key)
      && entry.runtimeKey === runtimeKey
      && entry.sideSessionId
    ));
    const candidateKey = candidate?.[0] ?? null;
    const candidateEntry = candidate?.[1] ?? null;
    const identity = candidate ? toIdentity(candidate[1]) : null;
    if (!identity) return;

    const panelTabs = useUIStore.getState().contextPanelByDirectory[identity.directory]?.tabs ?? [];
    if (panelTabs.some((tab) => tab.disposableSideChat?.sideSessionId === identity.sideSessionId)) {
      if (candidateKey) handledKeysRef.current.add(candidateKey);
      return;
    }

    let cancelled = false;
    const operation = captureSideChatRuntimeOperation();
    void operation.client.session.get({ sessionID: identity.sideSessionId, directory: identity.directory })
      .then((result) => {
        if (result.error) {
          const error = new Error('Failed to inspect side chat') as Error & { status?: number };
          error.status = result.response?.status;
          throw error;
        }
        const session = result.data;
        if (cancelled || !operation.isCurrent() || !session) return;
        if (!isDisposableSideChat(session)) {
          if (candidateEntry?.phase === 'cleanup-pending') {
            setRecoverable(identity);
            return;
          }
          useDisposableSideChatsStore.getState().complete(identity);
          if (candidateKey) handledKeysRef.current.add(candidateKey);
          return;
        }
        setRecoverable(identity);
      })
      .catch((error) => {
        if (cancelled || !operation.isCurrent() || (error as { status?: number })?.status !== 404) return;
        useDisposableSideChatsStore.getState().reconcileNotFound(identity);
        if (candidateKey) handledKeysRef.current.add(candidateKey);
      });
    return () => { cancelled = true; };
  }, [enabled, entries, recoverable]);

  if (!recoverable) return null;

  const recover = () => {
    if (getRuntimeKey() !== recoverable.runtimeKey) return;
    const entry = useDisposableSideChatsStore.getState().findBySide(
      recoverable.runtimeKey,
      recoverable.directory,
      recoverable.sideSessionId,
    );
    if (entry) handledKeysRef.current.add([...entries].find(([, value]) => value === entry)?.[0] ?? '');
    useUIStore.getState().openContextPanelTab(recoverable.directory, {
      mode: 'chat',
      dedupeKey: `session:${recoverable.sideSessionId}`,
      disposableSideChat: recoverable,
    });
    setRecoverable(null);
  };

  const remove = async () => {
    if (getRuntimeKey() !== recoverable.runtimeKey) return;
    const operation = captureSideChatRuntimeOperation();
    setIsWorking(true);
    useDisposableSideChatsStore.getState().setPhase(recoverable, 'cleanup-pending');
    const result = await closeDisposableSideChat(recoverable, {
      isActive: () => false,
      abort: async () => {},
      waitUntilSettled: async () => true,
       deleteSession: () => deleteSessionInCapturedRuntime(recoverable.sideSessionId, recoverable.directory, operation),
      complete: (identity) => useDisposableSideChatsStore.getState().complete(identity),
       closeTab: () => {
         if (!operation.isCurrent()) return;
        const tabID = getSessionContextPanelTabID(recoverable.sideSessionId);
        if (tabID) useUIStore.getState().closeContextPanelTab(recoverable.directory, tabID);
      },
    });
    setIsWorking(false);
    if (result.ok) {
      const key = [...entries].find(([, entry]) => entry.sideSessionId === recoverable.sideSessionId)?.[0];
      if (key) handledKeysRef.current.add(key);
      setRecoverable(null);
    }
    else toast.error(t('sideChat.cleanup.error'), { description: result.error.message });
  };

  return (
    <Dialog open onOpenChange={() => {}}>
      <DialogContent showCloseButton={false} className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('sideChat.recovery.title')}</DialogTitle>
          <DialogDescription>{t('sideChat.recovery.description')}</DialogDescription>
        </DialogHeader>
        <div className="rounded-lg border border-border/60 bg-[var(--surface-muted)] px-3 py-2 typography-micro text-muted-foreground">
          {t('sideChat.recovery.sessionLabel', { sessionID: recoverable.sideSessionId })}
        </div>
        <DialogFooter>
          <Button variant="destructive" onClick={() => { void remove(); }} disabled={isWorking}>
            {t('sideChat.recovery.delete')}
          </Button>
          <Button onClick={recover} disabled={isWorking}>{t('sideChat.recovery.recover')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
