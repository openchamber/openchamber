import { useFileTreeUpload } from '../useFileTreeUpload';
import { type useFileDirectory } from './useFileDirectory';
import { type useFileScope } from './useFileScope';

export function useFileUploads({ fileDirectory, scope }: {
  fileDirectory: Pick<ReturnType<typeof useFileDirectory>, 'refreshDirectory'>;
  scope: Pick<ReturnType<typeof useFileScope>, 'root'>;
}) {
  const { refreshDirectory } = fileDirectory;
  const { root } = scope;
  const {
    canUpload,
    uploadingDirectory,
    pickFiles,
    uploadElements,
  } = useFileTreeUpload({ root, refreshDirectory });
  const isUploading = uploadingDirectory !== null;

  return { canUpload, pickFiles, uploadElements, isUploading };
}
