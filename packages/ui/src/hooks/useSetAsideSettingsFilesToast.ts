import { useEffect } from 'react';
import { toast } from '@/components/ui/toast';
import { formatMessage, useI18nStore } from '@/lib/i18n';
import { subscribeToSetAsideSettingsFiles, takeSetAsideSettingsFiles } from '@/lib/settings/setAsideSettingsFiles';

export const useSetAsideSettingsFilesToast = (): void => {
  const dictionary = useI18nStore((state) => state.dictionary);

  useEffect(() => {
    const show = () => {
      const files = takeSetAsideSettingsFiles();
      if (files.length === 0) return;
      toast.warning(formatMessage(dictionary, files.length === 1 ? 'settings.files.reset.title' : 'settings.files.reset.titleMany'), {
        description: formatMessage(dictionary, 'settings.files.reset.description', { files: files.join(', ') }),
      });
    };
    show();
    return subscribeToSetAsideSettingsFiles(show);
  }, [dictionary]);
};
