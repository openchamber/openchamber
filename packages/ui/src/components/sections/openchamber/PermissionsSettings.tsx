import React from 'react';
import { useI18n } from '@/lib/i18n';
import { Checkbox } from '@/components/ui/checkbox';
import { Icon } from '@/components/icon/Icon';
import { useYoloStore } from '@/stores/useYoloStore';

const YOLO_CONFIRM_KEY = 'openchamber.yolo.confirmed.v1';

export const PermissionsSettings: React.FC = () => {
  const { t } = useI18n();
  const enabled = useYoloStore((state) => state.enabled);
  const loading = useYoloStore((state) => state.loading);
  const saving = useYoloStore((state) => state.saving);
  const lastError = useYoloStore((state) => state.lastError);
  const refresh = useYoloStore((state) => state.refresh);
  const setEnabled = useYoloStore((state) => state.setEnabled);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleToggle = React.useCallback(
    (next: boolean) => {
      if (next && typeof window !== 'undefined' && !window.localStorage.getItem(YOLO_CONFIRM_KEY)) {
        const accepted = window.confirm(t('settings.permissions.yolo.confirm.enable'));
        if (!accepted) {
          return;
        }
        window.localStorage.setItem(YOLO_CONFIRM_KEY, '1');
      }
      void setEnabled(next);
    },
    [setEnabled, t]
  );

  return (
    <div className="space-y-3">
      <div className="mb-1 px-1">
        <h2 className="typography-ui-header font-medium text-foreground">
          {t('settings.permissions.yolo.section.title')}
        </h2>
        <p className="typography-meta text-muted-foreground">
          {t('settings.permissions.yolo.section.description')}
        </p>
      </div>

      <section className="p-2">
        <div
          className="group flex cursor-pointer items-start gap-2 py-1.5"
          role="button"
          tabIndex={0}
          aria-pressed={enabled}
          onClick={() => {
            if (saving || loading) return;
            handleToggle(!enabled);
          }}
          onKeyDown={(event) => {
            if (event.key === ' ' || event.key === 'Enter') {
              event.preventDefault();
              if (saving || loading) return;
              handleToggle(!enabled);
            }
          }}
        >
          <span onClick={(e) => e.stopPropagation()}>
            <Checkbox
              checked={enabled}
              onChange={(next) => handleToggle(next)}
              ariaLabel={t('settings.permissions.yolo.toggle.aria')}
              disabled={saving || loading}
            />
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="typography-ui-label flex items-center gap-2 text-foreground">
              <Icon name="shield-keyhole" className="h-4 w-4" />
              {t('settings.permissions.yolo.toggle.label')}
              <span
                className="typography-micro shrink-0 px-1 pb-px leading-none rounded"
                style={{
                  color: 'var(--status-warning)',
                  backgroundColor: 'var(--status-warning-bg, rgba(234, 179, 8, 0.12))',
                }}
              >
                {t('settings.view.badge.beta')}
              </span>
            </span>
            <p className="typography-meta text-muted-foreground/70">
              {t('settings.permissions.yolo.toggle.description')}
            </p>
            {enabled ? (
              <p
                className="typography-meta mt-1 flex items-center gap-1"
                style={{ color: 'var(--status-warning)' }}
              >
                <Icon name="alert" className="h-3 w-3" />
                {t('settings.permissions.yolo.warning.active')}
              </p>
            ) : null}
            {lastError ? (
              <p
                className="typography-meta mt-1"
                style={{ color: 'var(--status-error)' }}
              >
                {t('settings.permissions.yolo.error.label', { message: lastError })}
              </p>
            ) : null}
          </div>
        </div>
      </section>
    </div>
  );
};
