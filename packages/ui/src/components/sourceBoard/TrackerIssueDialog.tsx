import * as React from 'react';

import { Icon } from '@/components/icon/Icon';
import { TRACKER_PRIORITY_KEYS } from '@/components/references/referencePickerItems';
import { SettingsStackedField } from '@/components/sections/shared/SettingsSection';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import type { TrackerItem, TrackerPriority } from '@/lib/api/types';
import { useI18n } from '@/lib/i18n';
import { createTrackerItem, editTrackerItem } from '@/lib/trackers/mutations';

const PRIORITIES: readonly TrackerPriority[] = ['none', 'urgent', 'high', 'medium', 'low'];

const labelsOf = (value: string): string[] => (
  value.split(',').map((label) => label.trim()).filter(Boolean)
);

/**
 * Create or edit one tracker item, from the board's New issue button and Edit
 * issue action. The form holds the fields `items/create` and `items/edit`
 * take; a failed submit keeps every field so the user can retry, and `onDone`
 * lets the caller refresh what it lists. The dialog's project options are the
 * caller's containers, the first of them preselected.
 */
export const TrackerIssueDialog: React.FC<{
  provider: string;
  mode: 'create' | 'edit';
  /** The containers (a Linear team, a local project) create mode offers. */
  containers: { id: string; name: string }[];
  /** The item edit mode works on. */
  initial?: TrackerItem;
  onDone: (item: TrackerItem) => void;
  onClose: () => void;
}> = ({ provider, mode, containers, initial, onDone, onClose }) => {
  const { t } = useI18n();
  const isCreate = mode === 'create';
  const [title, setTitle] = React.useState(initial?.title ?? '');
  const [description, setDescription] = React.useState(initial?.description ?? '');
  const [priority, setPriority] = React.useState<TrackerPriority>(initial?.priority ?? 'none');
  const [containerId, setContainerId] = React.useState(containers[0]?.id ?? '');
  const [labels, setLabels] = React.useState((initial?.labels ?? []).map((label) => label.name).join(', '));
  const [submitting, setSubmitting] = React.useState(false);
  const [failed, setFailed] = React.useState(false);

  const canSubmit = Boolean(title.trim()) && !submitting
    && (isCreate ? containerId !== '' : Boolean(initial?.id));
  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setFailed(false);
    try {
      const item = isCreate
        ? await createTrackerItem(provider, {
          containerId,
          title: title.trim(),
          description: description.trim() || null,
          priority,
          labels: labelsOf(labels),
        })
        : await editTrackerItem(provider, {
          id: initial?.id ?? '',
          title: title.trim(),
          description: description.trim() || null,
          priority,
          labels: labelsOf(labels),
        });
      onDone(item);
      onClose();
    } catch {
      // The fields stay as they are; only the footer says the submit failed.
      setFailed(true);
    } finally {
      setSubmitting(false);
    }
  };

  // A value outside the known set (a server ahead of this UI) reads as none.
  const priorityLabel = (value: string | undefined): string => {
    const priority = PRIORITIES.find((candidate) => candidate === value) ?? 'none';
    return priority === 'none' ? t('references.picker.filter.tracker.priority.none') : t(TRACKER_PRIORITY_KEYS[priority]);
  };
  const submitLabel = isCreate ? t('sourceBoard.tracker.create.submit') : t('sourceBoard.tracker.edit');
  const failureText = isCreate ? t('sourceBoard.tracker.create.failed') : t('sourceBoard.tracker.edit.failed');

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{isCreate ? t('sourceBoard.tracker.create.title') : t('sourceBoard.tracker.edit')}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-5">
          <SettingsStackedField label={t('gitView.pr.field.title')} controlClassName="max-w-none">
            <Input value={title} autoFocus onChange={(event) => setTitle(event.target.value)} />
          </SettingsStackedField>
          <SettingsStackedField label={t('gitView.pr.field.description')} controlClassName="max-w-none">
            <Textarea value={description} onChange={(event) => setDescription(event.target.value)} className="min-h-[120px]" />
          </SettingsStackedField>
          {isCreate ? (
            <SettingsStackedField label={t('sourceBoard.tracker.create.project')} controlClassName="max-w-none">
              <Select value={containerId} onValueChange={setContainerId}>
                <SelectTrigger className="w-full">
                  <SelectValue>{(value: string | undefined) => containers.find((container) => container.id === value)?.name ?? ''}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {containers.map((container) => (
                    <SelectItem key={container.id} value={container.id}>{container.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </SettingsStackedField>
          ) : null}
          <SettingsStackedField label={t('references.picker.preview.priority')} controlClassName="max-w-none">
            <Select value={priority} onValueChange={setPriority}>
              <SelectTrigger className="w-full">
                <SelectValue>{priorityLabel}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {PRIORITIES.map((value) => (
                  <SelectItem key={value} value={value}>{priorityLabel(value)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingsStackedField>
          <SettingsStackedField label={t('references.picker.preview.labels')} controlClassName="max-w-none">
            <Input value={labels} onChange={(event) => setLabels(event.target.value)} />
          </SettingsStackedField>
        </div>
        <DialogFooter>
          <div className="flex w-full flex-col gap-2 sm:flex-row sm:items-center">
            <p className="flex min-h-4 min-w-0 flex-1 items-center gap-1.5 typography-micro text-destructive" aria-live="polite">
              {failed ? <><Icon name="error-warning" className="size-3.5 shrink-0" />{failureText}</> : null}
            </p>
            <div className="flex shrink-0 gap-2">
              <Button type="button" variant="outline" size="sm" disabled={submitting} onClick={onClose}>
                {t('dialog.common.actions.cancel')}
              </Button>
              <Button type="button" size="sm" disabled={!canSubmit} onClick={() => void submit()}>
                {submitting ? <Icon name="loader-4" className="size-3.5 animate-spin" /> : null}
                {submitLabel}
              </Button>
            </div>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
