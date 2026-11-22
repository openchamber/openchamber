import { getRevealLabelKey, isMacOS } from '@/lib/utils';

export const getDirectoryPickerLabelKey = () => (
  isMacOS() ? 'directoryExplorerDialog.actions.openInFinder' : getRevealLabelKey()
);
