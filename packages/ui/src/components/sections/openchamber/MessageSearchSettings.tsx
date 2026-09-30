import React from 'react';

import { Button } from '@/components/ui/button';
import {
  SETTINGS_HELPER_CLASS,
  SettingsCheckboxRow,
  SettingsFieldRow,
  SettingsInset,
  SettingsSection,
} from '@/components/sections/shared/SettingsSection';
import { useI18n } from '@/lib/i18n';
import { getCurrentIntlLocale } from '@/lib/i18n/intl';
import {
  deleteMessageSearchIndex,
  readMessageSearchStatus,
  type MessageSearchServerStatus,
} from '@/lib/messageSearch';
import { useUIStore } from '@/stores/useUIStore';

// The server follows the switch after the debounced settings save, and fills
// the index in the background: the status is read again until it settles.
const STATUS_POLL_MS = 2_000;
const REASONING_WALK_GRACE_POLLS = 3;

type StatusView =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'ready'; status: MessageSearchServerStatus };

const isSettled = (status: MessageSearchServerStatus, enabled: boolean): boolean => {
  if (status.state === 'unsupported' || status.state === 'failed') return true;
  if (!enabled) return status.state === 'off';
  return status.state === 'on' && status.index?.backfill.state !== 'running';
};

const formatSize = (bytes: number): string => {
  const megabytes = bytes / 1_000_000;
  return new Intl.NumberFormat(getCurrentIntlLocale(), {
    style: 'unit',
    unit: 'megabyte',
    maximumFractionDigits: megabytes < 10 ? 1 : 0,
  }).format(megabytes);
};

/**
 * Settings → Chat → Message search. One opt-in switch: off, the server keeps
 * no index running and the palette and chat offer no message search. The
 * index row stays visible either way, with rebuild while on and delete while
 * off. Not offered in VS Code, which has no OpenChamber server.
 */
export const MessageSearchSettings: React.FC = () => {
  const { t } = useI18n();
  const enabled = useUIStore((state) => state.messageSearchEnabled);
  const setEnabled = useUIStore((state) => state.setMessageSearchEnabled);
  const reasoning = useUIStore((state) => state.messageSearchReasoningEnabled);
  const setReasoning = useUIStore((state) => state.setMessageSearchReasoningEnabled);
  const [view, setView] = React.useState<StatusView>({ kind: 'loading' });
  const [working, setWorking] = React.useState(false);

  // Turning reasoning on starts a walk that re-reads every conversation. The
  // save reaches the server after a debounce, so a settled answer right after
  // the switch may predate it: a few more reads wait for the walk to show up.
  const previousReasoningRef = React.useRef(reasoning);
  React.useEffect(() => {
    const expectWalk = enabled && reasoning && !previousReasoningRef.current;
    previousReasoningRef.current = reasoning;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let grace = expectWalk ? REASONING_WALK_GRACE_POLLS : 0;
    const poll = () => {
      readMessageSearchStatus(controller.signal)
        .then((status) => {
          if (controller.signal.aborted) return;
          setView({ kind: 'ready', status });
          if (status.index?.backfill.state === 'running') grace = 0;
          const waitForWalk = grace > 0;
          grace -= 1;
          if (!isSettled(status, enabled) || waitForWalk) timer = setTimeout(poll, STATUS_POLL_MS);
        })
        .catch(() => {
          if (!controller.signal.aborted) setView({ kind: 'error' });
        });
    };
    poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [enabled, reasoning]);

  const handleDelete = React.useCallback(() => {
    setWorking(true);
    deleteMessageSearchIndex()
      .then((status) => setView({ kind: 'ready', status }))
      .catch(() => setView({ kind: 'error' }))
      .finally(() => setWorking(false));
  }, []);

  const status = view.kind === 'ready' ? view.status : null;
  const unsupported = status?.state === 'unsupported';
  const size = formatSize(status?.sizeBytes ?? 0);

  let statusText: string;
  if (view.kind === 'loading') statusText = t('settings.openchamber.messageSearch.status.loading');
  else if (view.kind === 'error') statusText = t('settings.openchamber.messageSearch.status.error');
  else if (view.status.state === 'unsupported') statusText = t('settings.openchamber.messageSearch.status.unsupported');
  else if (!enabled) {
    statusText = view.status.sizeBytes > 0
      ? t('settings.openchamber.messageSearch.status.offWithFile', { size })
      : t('settings.openchamber.messageSearch.status.off');
  } else if (view.status.state === 'failed') statusText = t('settings.openchamber.messageSearch.status.failed');
  else if (view.status.state === 'on' && view.status.index?.backfill.state === 'running') {
    statusText = t('settings.openchamber.messageSearch.status.indexing', {
      done: view.status.index.backfill.done,
      total: view.status.index.backfill.total,
      size,
    });
  } else if (view.status.state === 'on' && view.status.index) {
    statusText = t('settings.openchamber.messageSearch.status.ready', {
      sessions: view.status.index.sessions,
      messages: view.status.index.messages,
      size,
    });
  } else {
    // Switched on, the server has not picked it up yet.
    statusText = t('settings.openchamber.messageSearch.status.loading');
  }

  return (
    <SettingsSection title={t('settings.openchamber.messageSearch.title')} settingsItem="chat.message-search">
      <SettingsCheckboxRow
        settingsItem="chat.message-search-enabled"
        checked={enabled}
        onChange={setEnabled}
        disabled={unsupported}
        label={t('settings.openchamber.messageSearch.field.enabled')}
        ariaLabel={t('settings.openchamber.messageSearch.field.enabled')}
        info={t('settings.openchamber.messageSearch.field.enabledInfo')}
      />
      <SettingsInset>
        <SettingsCheckboxRow
          settingsItem="chat.message-search-reasoning"
          checked={enabled && reasoning}
          onChange={setReasoning}
          disabled={!enabled || unsupported}
          label={t('settings.openchamber.messageSearch.field.reasoning')}
          ariaLabel={t('settings.openchamber.messageSearch.field.reasoning')}
          info={t('settings.openchamber.messageSearch.field.reasoningInfo')}
        />
        <SettingsFieldRow label={t('settings.openchamber.messageSearch.field.index')}>
          {enabled ? (
            <Button
              type="button"
              variant="outline"
              size="xs"
              className="!font-normal"
              onClick={handleDelete}
              disabled={working || (status?.state !== 'on' && status?.state !== 'failed')}
            >
              {working ? t('settings.openchamber.messageSearch.actions.working') : t('settings.openchamber.messageSearch.actions.rebuild')}
            </Button>
          ) : (
            <Button
              type="button"
              variant="outline"
              size="xs"
              className="!font-normal"
              onClick={handleDelete}
              disabled={working || !status || status.state === 'on' || status.sizeBytes === 0}
            >
              {working ? t('settings.openchamber.messageSearch.actions.working') : t('settings.openchamber.messageSearch.actions.delete')}
            </Button>
          )}
        </SettingsFieldRow>
        <p className={SETTINGS_HELPER_CLASS} aria-live="polite">{statusText}</p>
      </SettingsInset>
    </SettingsSection>
  );
};
