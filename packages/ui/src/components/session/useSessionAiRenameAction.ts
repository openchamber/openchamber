import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { isVSCodeRuntime } from '@/lib/desktop';
import { useI18n } from '@/lib/i18n';
import { subscribeRuntimeEndpointWillChange } from '@/lib/runtime-switch';
import { useIsSessionAiRenamePending, useSessionAiRename } from '@/sync/use-session-ai-rename';

/** Menus and mobile swipe actions check history only while their controls are open. */
export function useSessionAiRenameAction(sessionID: string, directory: string | null | undefined, open: boolean) {
  const { t } = useI18n();
  const { prepare, rename } = useSessionAiRename(sessionID, directory);
  const pending = useIsSessionAiRenamePending(sessionID, directory);
  const [availability, setAvailability] = useState<'checking' | 'ready' | 'empty' | 'error'>('checking');
  const unsupported = isVSCodeRuntime();

  useEffect(() => {
    if (!open || !directory || unsupported || pending) return;
    const controller = new AbortController();
    const unsubscribe = subscribeRuntimeEndpointWillChange(() => controller.abort());
    setAvailability('checking');
    void prepare(controller.signal).then(({ turns }) => {
      if (!controller.signal.aborted) setAvailability(turns.length ? 'ready' : 'empty');
    }).catch(() => {
      if (!controller.signal.aborted) setAvailability('error');
    });
    return () => { controller.abort(); unsubscribe(); };
  }, [directory, open, pending, prepare, unsupported]);

  const disabled = unsupported || !directory || pending || availability === 'checking' || availability === 'empty';
  const hint = unsupported ? t('sessions.aiRename.unsupported')
    : pending ? t('sessions.aiRename.generating')
      : availability === 'checking' ? t('sessions.aiRename.checking')
        : availability === 'empty' ? t('sessions.aiRename.noCompletedTurns')
          : t('sessions.aiRename.action');
  const run = useCallback(() => {
    void rename().catch(() => toast.error(t('sessions.aiRename.failed')));
  }, [rename, t]);

  return { pending, disabled, hint, run };
}
