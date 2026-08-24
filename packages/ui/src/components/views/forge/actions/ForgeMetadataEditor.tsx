import React, { useState } from 'react';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { useI18n } from '@/lib/i18n';
import type { I18nKey } from '@/lib/i18n';
import type { ForgeEntityRef, ForgeProvider } from '@/lib/forge/provider';
import type { ForgeLabel, ForgeMilestone, ForgeUser } from '@/lib/forge/types';
import { ForgeLookupCombobox } from './ForgeLookupCombobox';
import type { ForgeLookupOption } from './useForgeLookup';

interface ForgeMetadataEditorProps {
  provider: ForgeProvider;
  directory: string;
  ref: ForgeEntityRef;
  labels: ForgeLabel[];
  assignees: ForgeUser[];
  milestone: ForgeMilestone | null | undefined;
  onChanged?: () => void;
}

const chipClassName =
  'inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-surface-elevated px-2 py-0.5 typography-micro text-foreground';

const removeButtonClassName =
  'inline-flex size-4 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-interactive-hover/60 hover:text-foreground disabled:pointer-events-none disabled:opacity-50';

const avatarSize = 'size-3.5 rounded-full';

/** GitHub label colors arrive without the `#` prefix; normalize both spellings. */
const resolveLabelColor = (color?: string): string | null => {
  if (!color) return null;
  const value = color.trim();
  if (!value) return null;
  return value.startsWith('#') ? value : `#${value}`;
};

/**
 * Metadata editor for an issue: labels / assignees / milestone chips with a
 * remove affordance plus per-category add inputs. Every write replaces the
 * full set of the changed field only (`provider.updateMetadata` semantics).
 * Renders nothing when `updateMetadata` is missing or no category is enabled.
 */
export const ForgeMetadataEditor: React.FC<ForgeMetadataEditorProps> = ({
  provider,
  directory,
  ref,
  labels,
  assignees,
  milestone,
  onChanged,
}) => {
  const { t } = useI18n();
  const [labelInput, setLabelInput] = useState('');
  const [assigneeInput, setAssigneeInput] = useState('');
  const [milestoneInput, setMilestoneInput] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const updateMetadata = provider.updateMetadata;
  const canLabels = Boolean(updateMetadata) && provider.capabilities.labels;
  const canAssignees = Boolean(updateMetadata) && provider.capabilities.assignees;
  const canMilestones = Boolean(updateMetadata) && provider.capabilities.milestones;

  if (!updateMetadata || (!canLabels && !canAssignees && !canMilestones)) return null;

  const runMetadata = async (
    input: { labels?: string[]; assignees?: string[]; milestone?: string | null },
    successKey: I18nKey,
  ): Promise<void> => {
    if (submitting) return;
    setSubmitting(true);
    try {
      const result = await updateMetadata(directory, ref, input);
      if (!result.ok) {
        toast.error(t('forge.actions.error'));
        return;
      }
      toast.success(t(successKey));
      onChanged?.();
    } finally {
      setSubmitting(false);
    }
  };

  const addLabel = async (): Promise<void> => {
    const name = labelInput.trim();
    if (!name) return;
    await runMetadata({ labels: [...labels.map((label) => label.name), name] }, 'forge.actions.added');
    setLabelInput('');
  };

  const addLabelOption = async (option: ForgeLookupOption): Promise<void> => {
    setLabelInput(option.label);
    await addLabel();
  };

  const removeLabel = async (name: string): Promise<void> => {
    await runMetadata({ labels: labels.filter((label) => label.name !== name).map((label) => label.name) }, 'forge.actions.removed');
  };

  const addAssignee = async (): Promise<void> => {
    const login = assigneeInput.trim();
    if (!login) return;
    await runMetadata({ assignees: [...assignees.map((assignee) => assignee.login), login] }, 'forge.actions.added');
    setAssigneeInput('');
  };

  const addAssigneeOption = async (option: ForgeLookupOption): Promise<void> => {
    setAssigneeInput(option.label);
    await addAssignee();
  };

  const removeAssignee = async (id: string): Promise<void> => {
    await runMetadata({ assignees: assignees.filter((assignee) => assignee.id !== id).map((assignee) => assignee.login) }, 'forge.actions.removed');
  };

  const addMilestone = async (): Promise<void> => {
    const title = milestoneInput.trim();
    if (!title) return;
    await runMetadata({ milestone: title }, 'forge.actions.metadataChanged');
    setMilestoneInput('');
  };

  const addMilestoneOption = async (option: ForgeLookupOption): Promise<void> => {
    setMilestoneInput(option.label);
    await addMilestone();
  };

  const removeMilestone = async (): Promise<void> => {
    await runMetadata({ milestone: null }, 'forge.actions.removed');
  };

  const renderAvatar = (user: ForgeUser): React.ReactElement => {
    if (user.avatarUrl) {
      return <img src={user.avatarUrl} alt={user.login} className={`${avatarSize} object-cover`} />;
    }
    return (
      <span className={`${avatarSize} flex items-center justify-center bg-interactive-hover text-[10px] font-medium text-foreground`}>
        {(user.login || user.name || '?').charAt(0).toUpperCase()}
      </span>
    );
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        {canLabels
          ? labels.map((label) => (
              <span key={label.name} className={chipClassName} title={label.description || label.name}>
                <span
                  aria-hidden
                  className="size-2 rounded-full"
                  style={{ backgroundColor: resolveLabelColor(label.color) ?? 'var(--status-info)' }}
                />
                {label.name}
                <button
                  type="button"
                  className={removeButtonClassName}
                  onClick={() => void removeLabel(label.name)}
                  disabled={submitting}
                  aria-label={`${t('forge.actions.remove')}: ${label.name}`}
                >
                  <Icon name="close" className="size-3" />
                </button>
              </span>
            ))
          : null}

        {canAssignees
          ? assignees.map((assignee) => (
              <span key={assignee.id} className={chipClassName} title={assignee.login}>
                {renderAvatar(assignee)}
                {assignee.login}
                <button
                  type="button"
                  className={removeButtonClassName}
                  onClick={() => void removeAssignee(assignee.id)}
                  disabled={submitting}
                  aria-label={`${t('forge.actions.remove')}: ${assignee.login}`}
                >
                  <Icon name="close" className="size-3" />
                </button>
              </span>
            ))
          : null}

        {canMilestones && milestone ? (
          <span className={chipClassName} title={milestone.title}>
            <Icon name="target" className="size-3 text-muted-foreground" />
            {milestone.title}
            <button
              type="button"
              className={removeButtonClassName}
              onClick={() => void removeMilestone()}
              disabled={submitting}
              aria-label={`${t('forge.actions.remove')}: ${milestone.title}`}
            >
              <Icon name="close" className="size-3" />
            </button>
          </span>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {canLabels ? (
          <span className="flex items-center gap-1">
            <ForgeLookupCombobox
              provider={provider}
              directory={directory}
              kind="labels"
              value={labelInput}
              onChange={setLabelInput}
              onSelect={(option) => void addLabelOption(option)}
              placeholder={t('forge.actions.addLabel')}
              aria-label={t('forge.actions.addLabel')}
              className="h-6 w-36"
            />
            <Button variant="ghost" size="xs" onClick={() => void addLabel()} disabled={submitting || !labelInput.trim()}>
              {t('forge.actions.addLabel')}
            </Button>
          </span>
        ) : null}

        {canAssignees ? (
          <span className="flex items-center gap-1">
            <ForgeLookupCombobox
              provider={provider}
              directory={directory}
              kind="users"
              value={assigneeInput}
              onChange={setAssigneeInput}
              onSelect={(option) => void addAssigneeOption(option)}
              placeholder={t('forge.actions.addAssignee')}
              aria-label={t('forge.actions.addAssignee')}
              className="h-6 w-36"
            />
            <Button variant="ghost" size="xs" onClick={() => void addAssignee()} disabled={submitting || !assigneeInput.trim()}>
              {t('forge.actions.addAssignee')}
            </Button>
          </span>
        ) : null}

        {canMilestones ? (
          <span className="flex items-center gap-1">
            <ForgeLookupCombobox
              provider={provider}
              directory={directory}
              kind="milestones"
              value={milestoneInput}
              onChange={setMilestoneInput}
              onSelect={(option) => void addMilestoneOption(option)}
              placeholder={t('forge.actions.setMilestone')}
              aria-label={t('forge.actions.setMilestone')}
              className="h-6 w-36"
            />
            <Button variant="ghost" size="xs" onClick={() => void addMilestone()} disabled={submitting || !milestoneInput.trim()}>
              {t('forge.actions.setMilestone')}
            </Button>
          </span>
        ) : null}
      </div>
    </div>
  );
};
