import React from 'react';

import { WorkStatusGoalRow } from './WorkStatusGoalRow';
import { WorkStatusPrimaryGroup } from './WorkStatusPrimaryGroup';
import { WorkStatusUsageSection } from './WorkStatusUsageSection';
import { WorkStatusTelemetrySection } from './WorkStatusTelemetrySection';
import { WorkStatusSubagentsSection } from './WorkStatusSubagentsSection';
import { WorkStatusWorkflowsSection } from './WorkStatusWorkflowsSection';
import { WorkStatusMcpSection } from './WorkStatusMcpSection';
import { WorkStatusPinnedSection } from './WorkStatusPinnedSection';
import { WorkStatusContextSection } from './WorkStatusContextSection';
import { WorkStatusExtensionSection } from './WorkStatusExtensionSection';
import { isExtensionSectionId, isWorkStatusSectionVisible, type WorkStatusSectionId } from './sections';
import type { WorkStatusSectionLayout } from './useWorkStatusSectionLayout';

/**
 * The sections in the user's order, without the surface around them: the
 * desktop card and the phone's Status tab both render this.
 */
export const WorkStatusSectionList: React.FC<{
  sessionId: string | null;
  directory: string | null;
  repositoryEnabled: boolean;
  layout: WorkStatusSectionLayout;
}> = ({ sessionId, directory, repositoryEnabled, layout }) => {
  const { extensionSections, sectionOrder, hiddenSections } = layout;
  const sectionVisible = (id: Parameters<typeof isWorkStatusSectionVisible>[1]) => isWorkStatusSectionVisible(hiddenSections, id);

  // Keep these elements owned here so primary readout updates do not rerender
  // unrelated sections through the composition callback.
  const secondarySections = {
    usage: <WorkStatusUsageSection />,
    telemetry: <WorkStatusTelemetrySection sessionId={sessionId} directory={directory} />,
    subagents: <WorkStatusSubagentsSection sessionId={sessionId} directory={directory} />,
    workflows: <WorkStatusWorkflowsSection sessionId={sessionId} directory={directory} />,
    mcp: <WorkStatusMcpSection sessionId={sessionId} directory={directory} />,
    pinned: <WorkStatusPinnedSection sessionId={sessionId} directory={directory} />,
    contextSources: <WorkStatusContextSection sessionId={sessionId} directory={directory} />,
  } satisfies Record<Exclude<WorkStatusSectionId, 'session' | 'repository'>, React.ReactNode>;

  return (
    <WorkStatusPrimaryGroup
      sessionId={sessionId}
      directory={directory}
      showSession={sectionVisible('session')}
      showRepository={repositoryEnabled && sectionVisible('repository')}
      goalRow={<WorkStatusGoalRow sessionId={sessionId} directory={directory} />}
    >
      {(primary) => sectionOrder.map((id) => {
        if (!sectionVisible(id)) return null;
        if (isExtensionSectionId(id)) {
          const guest = extensionSections.byId.get(id);
          return guest ? <WorkStatusExtensionSection key={id} guest={guest} directory={directory} /> : null;
        }
        return <React.Fragment key={id}>{id === 'session' || id === 'repository' ? primary[id] : secondarySections[id]}</React.Fragment>;
      })}
    </WorkStatusPrimaryGroup>
  );
};
