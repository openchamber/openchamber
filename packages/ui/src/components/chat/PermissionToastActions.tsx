import React from 'react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';

interface PermissionToastActionsProps {
  sessionTitle: string;
  permissionBody: string;
  disabled?: boolean;
  onOnce: () => Promise<void> | void;
  onAlways: () => Promise<void> | void;
  onDeny: () => Promise<void> | void;
}

const truncateToastText = (value: string, maxLength: number): string => {
  const normalized = value.trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
};

export const PermissionToastActions: React.FC<PermissionToastActionsProps> = ({
  sessionTitle,
  permissionBody,
  disabled = false,
  onOnce,
  onAlways,
  onDeny,
}) => {
  const { t } = useI18n();
  const [isBusy, setIsBusy] = React.useState(false);
  const hasSessionTitle = sessionTitle.trim().length > 0;
  const sessionPreview = truncateToastText(sessionTitle, 64) || t('chat.permissionToast.sessionFallback');
  const permissionPreview = truncateToastText(permissionBody, 120) || t('chat.permissionToast.permissionFallback');

  const handleAction = async (action: () => Promise<void> | void) => {
    if (isBusy || disabled) return;
    setIsBusy(true);
    try {
      await action();
    } finally {
      setIsBusy(false);
    }
  };

  return (
    <div className="min-w-0">
      <div className="mb-1.5 min-w-0 space-y-0.5">
        <p className="typography-meta text-muted-foreground" title={sessionTitle}>
          {t('chat.permissionToast.labels.session')}{' '}
          <span className="inline-block max-w-[280px] align-bottom truncate text-foreground">
            {sessionPreview}
          </span>
        </p>
        <p className="typography-meta text-muted-foreground" title={permissionBody}>
          {t('chat.permissionToast.labels.permission')}{' '}
          <span className="inline-block max-w-[280px] align-bottom truncate">
            {permissionPreview}
          </span>
        </p>
      </div>

      <div className="flex items-center gap-1.5">
        <button
          onClick={() => handleAction(onOnce)}
          disabled={disabled || isBusy}
          aria-label={hasSessionTitle
            ? t('chat.permissionToast.actions.approveOnceAriaWithSession', { session: sessionTitle })
            : t('chat.permissionToast.actions.approveOnceAria')}
          className={cn(
            "px-2 py-1 typography-meta font-medium rounded transition-colors h-6",
            "disabled:opacity-50 disabled:cursor-not-allowed"
          )}
          style={{
            backgroundColor: 'rgb(var(--status-success) / 0.1)',
            color: 'var(--status-success)'
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = 'rgb(var(--status-success) / 0.2)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = 'rgb(var(--status-success) / 0.1)';
          }}
        >
          {t('chat.permissionToast.actions.once')}
        </button>

        <button
          onClick={() => handleAction(onAlways)}
          disabled={disabled || isBusy}
          aria-label={hasSessionTitle
            ? t('chat.permissionToast.actions.approveAlwaysAriaWithSession', { session: sessionTitle })
            : t('chat.permissionToast.actions.approveAlwaysAria')}
          className={cn(
            "px-2 py-1 typography-meta font-medium rounded transition-colors h-6",
            "disabled:opacity-50 disabled:cursor-not-allowed"
          )}
          style={{
            backgroundColor: 'rgb(var(--muted) / 0.5)',
            color: 'var(--muted-foreground)'
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = 'rgb(var(--muted) / 0.7)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = 'rgb(var(--muted) / 0.5)';
          }}
        >
          {t('chat.permissionToast.actions.always')}
        </button>

        <button
          onClick={() => handleAction(onDeny)}
          disabled={disabled || isBusy}
          aria-label={hasSessionTitle
            ? t('chat.permissionToast.actions.denyAriaWithSession', { session: sessionTitle })
            : t('chat.permissionToast.actions.denyAria')}
          className={cn(
            "px-2 py-1 typography-meta font-medium rounded transition-colors h-6",
            "disabled:opacity-50 disabled:cursor-not-allowed"
          )}
          style={{
            backgroundColor: 'rgb(var(--status-error) / 0.1)',
            color: 'var(--status-error)'
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = 'rgb(var(--status-error) / 0.2)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = 'rgb(var(--status-error) / 0.1)';
          }}
        >
          {t('chat.permissionToast.actions.deny')}
        </button>
      </div>
    </div>
  );
};
