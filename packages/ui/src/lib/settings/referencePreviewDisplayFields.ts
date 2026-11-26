import {
  readReferencePreviewDisplay,
  writeReferencePreviewDisplay,
  type ReferencePreviewDisplaySettings,
} from '@/stores/useReferencePreviewDisplayStore';

import { parseBoolean } from './parsers';
import type { SettingsFieldSpec } from './registry';

const displayField = <K extends keyof ReferencePreviewDisplaySettings>(key: K): SettingsFieldSpec<ReferencePreviewDisplaySettings[K]> => ({
  scope: 'profile',
  parse: parseBoolean,
  ui: {
    read(): ReferencePreviewDisplaySettings[K] {
      return readReferencePreviewDisplay()[key];
    },
    write(value: ReferencePreviewDisplaySettings[K]): void {
      // SAFETY: a single-key patch built from the key it is typed by.
      writeReferencePreviewDisplay({ [key]: value } as Pick<ReferencePreviewDisplaySettings, K>);
    },
    autoSave: false,
  },
});

export const REFERENCE_PREVIEW_DISPLAY_FIELDS = {
  referencePreviewNewestFirst: displayField('referencePreviewNewestFirst'),
  referencePreviewCollapseDescription: displayField('referencePreviewCollapseDescription'),
};
