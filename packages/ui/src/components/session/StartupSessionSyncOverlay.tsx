import React from 'react';

import { useI18n } from '@/lib/i18n';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';

export const StartupSessionSyncOverlay: React.FC = () => {
  const active = useGlobalSessionsStore((state) => state.startupSyncProgress.active);
  const phase = useGlobalSessionsStore((state) => state.startupSyncProgress.phase);
  const completed = useGlobalSessionsStore((state) => state.startupSyncProgress.completed);
  const total = useGlobalSessionsStore((state) => state.startupSyncProgress.total);
  const { t } = useI18n();

  const percentage = total > 0 ? Math.round((completed / total) * 100) : 0;
  const progressLabel = phase === 'restoring'
    ? t('common.loading')
    : t('sessions.startupSync.progress', { completed, total });

  React.useLayoutEffect(() => {
    const container = document.getElementById('startup-session-progress');
    const track = document.getElementById('startup-session-progress-track');
    const fill = document.getElementById('startup-session-progress-fill');
    const text = document.getElementById('startup-session-progress-text');
    if (!container || !track || !fill || !text) return;

    container.hidden = !active;
    if (!active) return;

    fill.style.width = `${percentage}%`;
    track.setAttribute('aria-label', t('sessions.startupSync.title'));
    track.setAttribute('aria-valuemax', String(Math.max(total, 1)));
    track.setAttribute('aria-valuenow', String(completed));
    track.setAttribute('aria-valuetext', progressLabel);
    text.textContent = progressLabel;
  }, [active, completed, percentage, progressLabel, t, total]);

  return null;
};
