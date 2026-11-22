import React from 'react';
import { languageByExtension, loadLanguageByExtension } from '@/lib/codemirror/languageByExtension';
import { type Extension } from '@codemirror/state';
import { type useFileTabs } from './useFileTabs';

export function useFileLanguage({ tabs }: {
  tabs: Pick<ReturnType<typeof useFileTabs>, 'selectedFile' | 'selectedFilePath'>;
}) {
  const { selectedFile, selectedFilePath } = tabs;

  const staticLanguageExtension = React.useMemo(
    () => (selectedFilePath ? languageByExtension(selectedFilePath) : null),
    [selectedFilePath],
  );
  const [dynamicLanguageExtension, setDynamicLanguageExtension] = React.useState<Extension | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    const selectedPath = selectedFile?.path;

    if (!selectedPath || staticLanguageExtension) {
      setDynamicLanguageExtension(null);
      return;
    }

    setDynamicLanguageExtension(null);
    void loadLanguageByExtension(selectedPath).then((extension) => {
      if (!cancelled) {
        setDynamicLanguageExtension(extension);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [selectedFile?.path, staticLanguageExtension]);
  return {
  staticLanguageExtension, dynamicLanguageExtension,
  };
}
