import React from 'react';
import { useI18n } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import { SettingsCheckboxRow } from '@/components/sections/shared/SettingsSection';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  WORK_STATUS_SECTION_IDS,
  WORK_STATUS_SECTION_LABEL_KEYS,
  areAllWorkStatusSectionsHidden,
  isWorkStatusSectionVisible,
} from './sections';

/**
 * Which sections the work-status panel may show.
 *
 * Everything is on by default and the choice is stored as the *hidden* set, so
 * a section added in a later release appears for everyone rather than staying
 * invisible to whoever had saved settings before it existed.
 */
export const WorkStatusSectionsDialog: React.FC<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
}> = ({ open, onOpenChange }) => {
  const { t } = useI18n();
  const hidden = useUIStore((state) => state.workStatusHiddenSections);
  const setSectionVisible = useUIStore((state) => state.setWorkStatusSectionVisible);
  const setHiddenSections = useUIStore((state) => state.setWorkStatusHiddenSections);

  const allVisible = hidden.length === 0;
  const noneVisible = areAllWorkStatusSectionsHidden(hidden);

  const handleShowAll = () => setHiddenSections([]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('chat.workStatus.sections.dialogTitle')}</DialogTitle>
          <DialogDescription>{t('chat.workStatus.sections.dialogDescription')}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col">
          {WORK_STATUS_SECTION_IDS.map((sectionId) => (
            <SettingsCheckboxRow
              key={sectionId}
              settingsItem={`chat.work-status.section.${sectionId}`}
              checked={isWorkStatusSectionVisible(hidden, sectionId)}
              onChange={(checked) => setSectionVisible(sectionId, checked)}
              label={t(WORK_STATUS_SECTION_LABEL_KEYS[sectionId])}
              ariaLabel={t(WORK_STATUS_SECTION_LABEL_KEYS[sectionId])}
            />
          ))}
        </div>

        {!allVisible ? (
          <div className="flex items-center justify-between border-t pt-3">
            {noneVisible ? (
              <span className="text-xs text-destructive">{t('chat.workStatus.sections.noneWarning')}</span>
            ) : <span />}
            <Button
              variant="link"
              size="xs"
              onClick={handleShowAll}
              className="normal-case text-muted-foreground hover:text-foreground"
            >
              {t('chat.workStatus.sections.showAll')}
            </Button>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
};
