import React from 'react';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { useI18n } from '@/lib/i18n';
import type { Session } from '@/lib/opencode/model';
import { useSessionUIStore } from '@/sync/session-ui-store';

export const MobileDeleteArchivedDialog: React.FC<{
  sessions: readonly Session[];
  onClose: () => void;
  onRemaining: (sessions: readonly Session[]) => void;
}> = ({ sessions, onClose, onRemaining }) => {
  const { t } = useI18n();
  const [processing, setProcessing] = React.useState(false);
  const processingRef = React.useRef(false);
  const close = () => { if (!processingRef.current) onClose(); };
  const confirm = async () => {
    if (processingRef.current || sessions.length === 0) return;
    processingRef.current = true;
    setProcessing(true);
    try {
      const store = useSessionUIStore.getState();
      const result = sessions.length === 1
        ? await store.deleteSession(sessions[0].id).then((success) => ({ deletedIds: success ? [sessions[0].id] : [], failedIds: success ? [] : [sessions[0].id] }))
        : await store.deleteSessions(sessions.map((session) => session.id));
      if (result.deletedIds.length > 0) toast.success(result.deletedIds.length === 1
        ? t('sessions.sidebar.bulkActions.deletedSingle', { count: result.deletedIds.length })
        : t('sessions.sidebar.bulkActions.deletedPlural', { count: result.deletedIds.length }));
      if (result.failedIds.length > 0) {
        toast.error(result.failedIds.length === 1
          ? t('sessions.sidebar.bulkActions.failedDeleteSingle', { count: result.failedIds.length })
          : t('sessions.sidebar.bulkActions.failedDeletePlural', { count: result.failedIds.length }));
        const failed = new Set(result.failedIds);
        onRemaining(sessions.filter((session) => failed.has(session.id)));
      } else onClose();
    } catch {
      toast.error(t('sessions.sidebar.session.delete.error'));
    } finally {
      processingRef.current = false;
      setProcessing(false);
    }
  };
  return <MobileOverlayPanel open title={t('sessions.sidebar.dialogs.deleteSessions.title')} onClose={close} footer={<div className="flex gap-2">
    <Button variant="ghost" className="flex-1" disabled={processing} onClick={close}>{t('sessions.sidebar.dialogs.cancel')}</Button>
    <Button variant="destructive" className="flex-1" disabled={processing} onClick={() => { void confirm(); }}>{t('sessions.sidebar.dialogs.deleteSessions.titleAction')}</Button>
  </div>}>
    <p className="px-1 py-1 typography-ui-body text-foreground">{sessions.length === 1
      ? t('sessions.sidebar.dialogs.deleteSessions.singleDescription', { count: sessions.length })
      : t('sessions.sidebar.dialogs.deleteSessions.pluralDescription', { count: sessions.length })}</p>
  </MobileOverlayPanel>;
};
