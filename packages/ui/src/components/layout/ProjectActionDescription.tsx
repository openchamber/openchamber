import { useI18n } from '@/lib/i18n';
import { AUTO_DISCOVER_ACTION_ID } from '@/lib/projectActions';
import type { OpenChamberProjectAction } from '@/lib/openchamberConfig';

export const ProjectActionDescription = ({ action }: { action: OpenChamberProjectAction }) => {
  const { t } = useI18n();
  if (action.id !== AUTO_DISCOVER_ACTION_ID) return null;
  return <span className="typography-micro text-muted-foreground">{t('projectActions.actions.autoDiscoverTooltip')}</span>;
};
