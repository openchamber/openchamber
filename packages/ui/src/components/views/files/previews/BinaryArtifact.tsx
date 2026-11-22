import React from 'react';

import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import { ContentState } from '@/components/ui/content-state';
import { useI18n } from '@/lib/i18n';
import { getFileExtension } from '@/lib/toolHelpers';
import { ArtifactMetaBar } from './ArtifactMetaBar';
import { formatArtifactSize } from './artifactMeta';

export const BinaryArtifact: React.FC<{
  name: string;
  path: string;
  sizeBytes: number | null;
  download?: React.ReactNode;
  description?: string;
}> = ({ name, path, sizeBytes, download, description }) => {
  const { t } = useI18n();
  const extension = getFileExtension(path).toUpperCase();
  return (
    <div className="flex h-full min-h-0 flex-col">
      <ArtifactMetaBar items={[extension, formatArtifactSize(sizeBytes)]} />
      <ContentState
        icon={<FileTypeIcon filePath={path} className="size-10" />}
        title={name}
        description={description ?? (extension
          ? t('filesView.artifact.binary.descriptionWithType', { extension })
          : t('filesView.artifact.binary.description'))}
        actions={download}
      />
    </div>
  );
};
