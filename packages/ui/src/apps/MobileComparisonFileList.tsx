import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import { ChangedPathLabel } from '@/components/views/git/ChangedPathLabel';
import { ChangeStats } from '@/components/views/git/ChangeRow';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { useI18n } from '@/lib/i18n';

type ComparisonFileListItem = { path: string; status: string; insertions: number; deletions: number; previousPath?: string };

export const MobileComparisonFileList = ({ files, onSelect, memoryKey, memoryReady }: {
  files: ComparisonFileListItem[];
  onSelect: (path: string) => void;
  memoryKey: string | null;
  memoryReady: boolean;
}) => {
  const { t } = useI18n();
  return (
    <ScrollableOverlay memoryKey={memoryKey} memoryReady={memoryReady} outerClassName="h-full" className="px-2 py-1" useScrollShadow disableHorizontal>
      <ul aria-label={t('gitView.changes.changedFilesAria')} className="flex flex-col">
        {files.map((file) => {
          const statusLabel = file.status === 'A' ? t('diffView.change.new')
            : file.status === 'D' ? t('diffView.change.deleted')
            : file.status === 'R' ? t('diffView.change.renamed')
            : file.status === 'C' ? t('diffView.change.copied') : t('diffView.change.modified');
          const statusColor = file.status === 'A' ? 'var(--status-success)' : file.status === 'D' ? 'var(--status-error)'
            : file.status === 'R' || file.status === 'C' ? 'var(--status-info)' : 'var(--status-warning)';
          return <li key={file.path}>
            <button
              type="button"
              className="flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-start touch-manipulation focus:outline-none active:bg-interactive-hover"
              onClick={() => onSelect(file.path)}
            >
              <span className="w-4 shrink-0 text-center typography-micro font-semibold uppercase" style={{ color: statusColor }} aria-label={statusLabel}>{file.status}</span>
              <FileTypeIcon filePath={file.path} className="size-3.5 shrink-0" />
              <ChangedPathLabel path={file.path} from={file.previousPath} nameFirst className="flex-1 typography-ui-label" />
              {(file.insertions > 0 || file.deletions > 0) && <ChangeStats insertions={file.insertions} deletions={file.deletions} hideZero />}
            </button>
          </li>;
        })}
      </ul>
    </ScrollableOverlay>
  );
};
