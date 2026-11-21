import type { ContentSearchStatus } from '@/hooks/useConversationSearch';
import { useI18n, type I18nKey } from '@/lib/i18n';

const failureKey = (status: ContentSearchStatus, messagesOnly: boolean): I18nKey | null => {
  if (status.kind === 'failed') return messagesOnly ? 'search.omni.status.failedMessagesOnly' : 'search.omni.status.failed';
  if (status.kind === 'error' || (status.kind === 'ready' && status.pageError)) return messagesOnly ? 'search.omni.status.errorMessagesOnly' : 'search.omni.status.error';
  return null;
};

export function useSearchFailureText(status: ContentSearchStatus, messagesOnly = false): string | null {
  const { t } = useI18n();
  const key = failureKey(status, messagesOnly);
  return key ? t(key) : null;
}
