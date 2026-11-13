import { Icon } from '@/components/icon/Icon';
import { SessionMenuItemHint } from '@/components/session/SessionMenuItemHint';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import type { Session } from '@/lib/opencode/model';
import { leaveFinishedSessions } from '@/lib/sessionTabs';
import { isSessionInWork } from '@/lib/sessionWorkMetadata';
import { resolveGlobalSessionDirectory } from '@/stores/useGlobalSessionsStore';
import { useUIStore } from '@/stores/useUIStore';
import { setSessionWorkState } from '@/sync/session-actions';
import type { SessionTabMenuComponents } from './SessionTabsStrip';

/**
 * Mark done for a header tab's session, the same action as the composer's:
 * this session alone leaves In work, and its tab closes.
 */
export function HeaderSessionMarkDoneMenuItem({ session, Item }: {
  session: Session;
  Item: SessionTabMenuComponents['Item'];
}) {
  const { t } = useI18n();
  const sessionWorkEnabled = useUIStore((state) => state.sessionWorkEnabled);

  if (!sessionWorkEnabled || session.parentID || !isSessionInWork(session)) return null;

  const markDone = async () => {
    try {
      await setSessionWorkState(session.id, resolveGlobalSessionDirectory(session), 'done');
      leaveFinishedSessions([session.id]);
    } catch {
      toast.error(t('sessions.sidebar.session.work.updateFailed'));
    }
  };

  return (
    <SessionMenuItemHint hint={t('sessions.sidebar.session.menuHint.markDone')}>
      <Item onClick={() => void markDone()}>
        <Icon name="check" className="me-1 size-4" />
        {t('sessions.sidebar.session.work.markDone')}
      </Item>
    </SessionMenuItemHint>
  );
}
