import React from 'react';
import { Checkbox } from '@/components/ui/checkbox';
import { useUIStore } from '@/stores/useUIStore';
import { useI18n } from '@/lib/i18n';
import { updateDesktopSettings } from '@/lib/persistence';

export const SidebarEmptyStateSettings: React.FC = () => {
  const { t } = useI18n();
  const hide = useUIStore((s) => s.hideSidebarEmptyState);
  const setHide = useUIStore((s) => s.setHideSidebarEmptyState);

  const handleToggle = React.useCallback(() => {
    const next = !hide;
    setHide(next);
    void updateDesktopSettings({ hideSidebarEmptyState: next });
  }, [hide, setHide]);

  return (
    <div className="mb-8">
      <div className="mb-1 px-1">
        <h3 className="typography-ui-header font-medium text-foreground">
          {t('settings.openchamber.sidebar.emptyState.title')}
        </h3>
      </div>
      <section className="px-2 pb-2 pt-0 space-y-0.5">
        <div
          className="group flex cursor-pointer items-center gap-2 py-1.5"
          role="button"
          tabIndex={0}
          aria-pressed={hide}
          onClick={handleToggle}
          onKeyDown={(event) => {
            if (event.key === ' ' || event.key === 'Enter') {
              event.preventDefault();
              handleToggle();
            }
          }}
        >
          <Checkbox
            checked={hide}
            onChange={handleToggle}
            ariaLabel={t('settings.openchamber.sidebar.emptyState.hideAria')}
          />
          <span className="typography-ui-label text-foreground">
            {t('settings.openchamber.sidebar.emptyState.hide')}
          </span>
        </div>
        <p className="typography-meta text-muted-foreground pl-[30px]">
          {t('settings.openchamber.sidebar.emptyState.hideDesc')}
        </p>
      </section>
    </div>
  );
};
