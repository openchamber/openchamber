import { Icon } from '@/components/icon/Icon';
import { clearSidebarFocus, useSidebarSectionsUiStore } from '@/components/session/sidebar/sections/sectionActions';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';

export const MobileSidebarFocusChip = () => {
  const { t } = useI18n();
  const focus = useSidebarSectionsUiStore((state) => state.focus);
  if (!focus) return null;
  return (
    <div className="flex shrink-0 px-3 pb-1 pt-1">
      <Button
        type="button"
        variant="chip"
        size="sm"
        aria-label={t('mobile.sessions.showAllAria')}
        title={t('mobile.sessions.showAllAria')}
        onClick={clearSidebarFocus}
        style={{ touchAction: 'manipulation' }}
      >
        {focus.name}
        <Icon name="close" className="size-4" />
      </Button>
    </div>
  );
};
