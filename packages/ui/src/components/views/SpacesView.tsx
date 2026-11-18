import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { SettingsSection } from '@/components/sections/shared/SettingsSection';
import { NewSpaceDialog } from '@/components/session/spaces/NewSpaceDialog';
import { SpaceRow } from '@/components/session/spaces/SpaceRow';
import { failureOfError, spaceFailureText } from '@/components/session/spaces/spaceFailureText';
import { useI18n } from '@/lib/i18n';
import { spacesOfProject, useSpacesJourneyRead } from '@/lib/spaces/spaces-store';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';

export function SpacesView(): React.ReactNode {
  const { t } = useI18n();
  const projectId = useUIStore((state) => state.spacesPageProjectId);
  const project = useProjectsStore((state) => state.projects.find((entry) => entry.id === projectId) ?? null);
  const { journey, error } = useSpacesJourneyRead();
  const [creating, setCreating] = React.useState(false);

  if (!project) return null;
  const spaces = journey ? spacesOfProject(journey, project.path) : [];

  return (
    <div className="absolute inset-0 z-10 flex flex-col bg-background">
      <ScrollableOverlay outerClassName="flex-1 min-h-0" className="px-6 py-4" disableHorizontal>
        <div className="mx-auto w-full max-w-4xl space-y-4">
          <SettingsSection
            title={t('spaces.page.listTitle')}
            headerAction={(
              <Button size="sm" onClick={() => setCreating(true)}>
                <Icon name="instance" className="me-1 h-3.5 w-3.5" />
                {t('spaces.page.new')}
              </Button>
            )}
          >
            {error ? (
              <p className="typography-meta text-[var(--status-error)]">{t('spaces.page.loadFailed', { reason: spaceFailureText(t, failureOfError(error)) })}</p>
            ) : null}
            {journey === null && !error ? <p className="typography-meta text-muted-foreground">{t('spaces.page.loading')}</p> : null}
            {journey !== null && !error && spaces.length === 0 ? <p className="typography-meta text-muted-foreground">{t('spaces.page.empty')}</p> : null}
            {spaces.length > 0 ? (
              <div className="space-y-1">
                {spaces.map((entry) => <SpaceRow key={entry.id} entry={entry} actions="menu" />)}
              </div>
            ) : null}
          </SettingsSection>
        </div>
      </ScrollableOverlay>
      {creating ? <NewSpaceDialog open onOpenChange={(open) => { if (!open) setCreating(false); }} project={{ id: project.id, path: project.path }} /> : null}
    </div>
  );
}
