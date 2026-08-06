import React from 'react';
import { useI18n } from '@/lib/i18n';
import { useSkillsStore } from '@/stores/useSkillsStore';
import { useMcpStore } from '@/stores/useMcpStore';
import { WorkStatusCollapsibleSection, WorkStatusRow, WorkStatusValue } from './WorkStatusPrimitives';

type Props = {
  directory: string | null;
};

/**
 * What is loaded into the agent's context. Agents themselves are not listed:
 * an agent is who does the work, not material the work is done with.
 *
 * Tools are absent for want of an honest source — `Agent.tools` is a per-agent
 * override map, not a registry, so counting it would report a number that means
 * something else.
 */
export const WorkStatusContextSection: React.FC<Props> = ({ directory }) => {
  const { t } = useI18n();

  const skills = useSkillsStore((state) => state.skills);
  const mcpStatus = useMcpStore(
    React.useCallback((state) => state.getStatusForDirectory(directory), [directory]),
  );

  const mcpCount = React.useMemo(() => Object.keys(mcpStatus ?? {}).length, [mcpStatus]);

  if (skills.length === 0 && mcpCount === 0) return null;

  return (
    <WorkStatusCollapsibleSection
      id="context-sources"
      title={t('chat.workStatus.section.contextBreakdown')}
      icon="stack"
      summary={`${skills.length} · ${mcpCount}`}
    >
      <WorkStatusRow
        muted
        label={t('chat.workStatus.breakdown.skills')}
        value={<WorkStatusValue>{skills.length}</WorkStatusValue>}
      />
      <WorkStatusRow
        muted
        label={t('chat.workStatus.breakdown.mcp')}
        value={<WorkStatusValue>{mcpCount}</WorkStatusValue>}
      />
    </WorkStatusCollapsibleSection>
  );
};
