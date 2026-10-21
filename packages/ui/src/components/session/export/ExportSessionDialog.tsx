/**
 * The one dialog that writes a session export.
 *
 * The Header and the Sidebar both open it, so the two places produce the
 * same document for the same session: the format, the detail level and the
 * sub-agent coverage are chosen here and nowhere else.
 */

import * as React from 'react';
import { useI18n } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Radio } from '@/components/ui/radio';
import type { ExportFormat } from '@/lib/exportSession';
import type { ProjectionMode } from '@/lib/export/project';
import { exportText } from '@/lib/export/i18n';

type ExportSessionDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The formats this session can be written in. */
  formats: ExportFormat[];
  /** The format the dialog writes. */
  format: ExportFormat;
  onFormatChange: (format: ExportFormat) => void;
  /** The detail level the dialog writes. */
  mode: ProjectionMode;
  onModeChange: (mode: ProjectionMode) => void;
  /** How many sub-agent tasks the session has, when it has any. */
  descendantCount?: number;
  /** Whether the sub-agent tasks are part of the export. */
  includeSubagents: boolean;
  onIncludeSubagentsChange: (include: boolean) => void;
  onConfirm: (format: ExportFormat, mode: ProjectionMode, includeSubagents: boolean) => void;
  /** Whether the export is running. */
  busy?: boolean;
};

const FORMAT_LABELS = new Map<ExportFormat, string>([
  ['markdown', 'Markdown'],
  ['html', 'HTML'],
  ['json', 'JSON'],
]);

/** What each format is for, in the reader's language. */
const FORMAT_HINT_KEYS = new Map<ExportFormat, Parameters<typeof exportText>[0]>([
  ['markdown', 'export.dialog.formatMarkdown'],
  ['html', 'export.dialog.formatHtml'],
  ['json', 'export.dialog.formatJson'],
]);

export const ExportSessionDialog: React.FC<ExportSessionDialogProps> = ({
  open,
  onOpenChange,
  formats,
  format,
  onFormatChange,
  mode,
  onModeChange,
  descendantCount = 0,
  includeSubagents,
  onIncludeSubagentsChange,
  onConfirm,
  busy = false,
}) => {
  const { t } = useI18n();

  const hasSubagents = descendantCount > 0;

  const handleConfirm = React.useCallback(() => {
    onConfirm(format, mode, includeSubagents);
  }, [format, includeSubagents, mode, onConfirm]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false} className="max-w-md gap-5">
        <DialogHeader>
          <DialogTitle>{t('sessions.sidebar.session.export.dialog.title')}</DialogTitle>
          <DialogDescription>
            {hasSubagents
              ? (descendantCount === 1
                ? t('sessions.sidebar.session.export.dialog.descriptionSingle', { count: descendantCount })
                : t('sessions.sidebar.session.export.dialog.descriptionMany', { count: descendantCount }))
              : t('sessions.sidebar.session.export.dialog.descriptionNoSubtasks')}
          </DialogDescription>
        </DialogHeader>

        <fieldset className="flex flex-col gap-2">
          <legend className="typography-ui-label mb-1">{t('sessions.sidebar.session.export.dialog.format')}</legend>
          {formats.map((option) => (
            <label key={option} className="flex cursor-pointer items-start gap-2">
              <Radio
                checked={format === option}
                onChange={() => onFormatChange(option)}
                ariaLabel={FORMAT_LABELS.get(option) ?? option}
                className="mt-0.5"
              />
              <span className="flex flex-col">
                <span className="typography-ui-label">{FORMAT_LABELS.get(option) ?? option}</span>
                <span className="typography-micro text-muted-foreground">
                  {exportText(FORMAT_HINT_KEYS.get(option) ?? 'export.dialog.formatMarkdown')}
                </span>
              </span>
            </label>
          ))}
        </fieldset>

        {format === 'json' ? null : (
          <fieldset className="flex flex-col gap-2">
            <legend className="typography-ui-label mb-1">{t('sessions.sidebar.session.export.dialog.detail')}</legend>
            <label className="flex cursor-pointer items-start gap-2">
              <Radio
                checked={mode === 'readable'}
                onChange={() => onModeChange('readable')}
                ariaLabel={t('sessions.sidebar.session.export.dialog.detailReadable')}
                className="mt-0.5"
              />
              <span className="flex flex-col">
                <span className="typography-ui-label">{t('sessions.sidebar.session.export.dialog.detailReadable')}</span>
                <span className="typography-micro text-muted-foreground">
                  {t('sessions.sidebar.session.export.dialog.detailReadableHint')}
                </span>
              </span>
            </label>
            <label className="flex cursor-pointer items-start gap-2">
              <Radio
                checked={mode === 'detailed'}
                onChange={() => onModeChange('detailed')}
                ariaLabel={t('sessions.sidebar.session.export.dialog.detailFull')}
                className="mt-0.5"
              />
              <span className="flex flex-col">
                <span className="typography-ui-label">{t('sessions.sidebar.session.export.dialog.detailFull')}</span>
                <span className="typography-micro text-muted-foreground">
                  {t('sessions.sidebar.session.export.dialog.detailFullHint')}
                </span>
              </span>
            </label>
          </fieldset>
        )}

        {hasSubagents ? (
          <label className="flex items-center gap-2 typography-ui-label cursor-pointer">
            <input
              type="checkbox"
              checked={includeSubagents}
              onChange={(event) => onIncludeSubagentsChange(event.target.checked)}
              className="h-4 w-4 rounded border-border accent-primary"
            />
            {t('sessions.sidebar.session.export.dialog.includeSubtasks')}
          </label>
        ) : null}

        <DialogFooter>
          <Button type="button" onClick={() => onOpenChange(false)} variant="outline" size="sm">
            {t('sessions.sidebar.dialogs.cancel')}
          </Button>
          <Button type="button" onClick={handleConfirm} size="sm" disabled={busy}>
            {t('sessions.sidebar.session.export.dialog.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
