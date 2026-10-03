import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { SettingsSection } from '@/components/sections/shared/SettingsSection';
import { NewSpaceDialog } from '@/components/session/spaces/NewSpaceDialog';
import { SpaceRow } from '@/components/session/spaces/SpaceRow';
import { failureOfError, spaceFailureText } from '@/components/session/spaces/spaceFailureText';
import { useI18n } from '@/lib/i18n';
import { spacesOfProject, useSpacesJourneyRead } from '@/lib/spaces/spaces-store';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';

// Full-page list of one project's isolated spaces (DESIGN.md, user journey step 9), opened from
// the project menu in the sidebar, beside its worktrees. Mounted by the main layout only while the
// feature's switch is on, and never in VS Code (decision 16). Each row is the space as its group
// in the sidebar shows it, with the same actions; "New isolated space" opens the create dialog of
// the new-session picker, which opens the draft and so closes this page.
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
      <div className="flex-1 overflow-y-auto px-6 py-4">
        <div className="mx-auto w-full max-w-4xl space-y-4">
          <div className="flex items-center">
            <Button size="sm" onClick={() => setCreating(true)}>
              <Icon name="box-3" className="mr-1 h-3.5 w-3.5" />
              {t('spaces.page.new')}
            </Button>
          </div>
          <SettingsSection title={t('spaces.page.listTitle')}>
            {error ? (
              <p className="typography-meta text-[var(--status-error)]">{t('spaces.page.loadFailed', { reason: spaceFailureText(t, failureOfError(error)) })}</p>
            ) : null}
            {journey === null && !error ? <p className="typography-meta text-muted-foreground">{t('spaces.page.loading')}</p> : null}
            {/* A read that failed says so and leaves the last list; it never says there are none. */}
            {journey !== null && !error && spaces.length === 0 ? <p className="typography-meta text-muted-foreground/70">{t('spaces.page.empty')}</p> : null}
            {spaces.length > 0 ? (
              <div className="space-y-1">
                {spaces.map((entry) => <SpaceRow key={entry.id} entry={entry} actions="menu" />)}
              </div>
            ) : null}
          </SettingsSection>
        </div>
      </div>
      {creating ? <NewSpaceDialog open onOpenChange={(open) => { if (!open) setCreating(false); }} project={{ id: project.id, path: project.path }} /> : null}
    </div>
  );
}
