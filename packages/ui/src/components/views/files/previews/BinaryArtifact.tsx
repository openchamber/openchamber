import React from 'react';

import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import { useI18n } from '@/lib/i18n';
import { getFileExtension } from '@/lib/toolHelpers';
import { ArtifactMetaBar } from './ArtifactMetaBar';
import { formatArtifactSize } from './artifactMeta';

/**
 * A file the viewer will not decode. It still tells the user what they have —
 * name, type, size — and hands them the download, rather than trying to read
 * the bytes as text and showing garbage.
 */
export const BinaryArtifact: React.FC<{
  name: string;
  path: string;
  sizeBytes: number | null;
  download?: React.ReactNode;
}> = ({ name, path, sizeBytes, download }) => {
  const { t } = useI18n();
  const extension = getFileExtension(path).toUpperCase();
  return (
    <div className="flex h-full min-h-0 flex-col">
      <ArtifactMetaBar items={[extension, formatArtifactSize(sizeBytes)]} />
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        <FileTypeIcon filePath={path} className="size-10" />
        <div className="max-w-full truncate typography-ui-header text-foreground">{name}</div>
        <div className="max-w-md typography-ui text-muted-foreground">
          {extension
            ? t('filesView.artifact.binary.descriptionWithType', { extension })
            : t('filesView.artifact.binary.description')}
        </div>
        {download}
      </div>
    </div>
  );
};
