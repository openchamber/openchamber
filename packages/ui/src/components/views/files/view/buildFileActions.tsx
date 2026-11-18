import { toast } from '@/components/ui';
import { type ToolbarGroup } from '@/components/ui/action-toolbar';
import { isDesktopLocalOriginActive } from '@/lib/desktop';
import { type useFileKinds } from './useFileKinds';
import { type useFileAssets } from './useFileAssets';
import { useFileClipboard } from './useFileClipboard';
import { type useFileTabs } from './useFileTabs';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useI18n } from '@/lib/i18n';
import type React from 'react';

export function buildFileActions({ clipboard, fileAssets, fileKinds, tabs, copyPathLabel, files, isMobile, openInAppMenuItems, pathLabelCopies, t }: {
  clipboard: Pick<ReturnType<typeof useFileClipboard>, 'copiedContent' | 'copiedPath' | 'copyContents' | 'copyPath'>;
  fileAssets: Pick<ReturnType<typeof useFileAssets>, 'exportDocument'>;
  fileKinds: Pick<ReturnType<typeof useFileKinds>, 'canCopy' | 'canCopyPath' | 'isMarkdown' | 'isTable'>;
  tabs: Pick<ReturnType<typeof useFileTabs>, 'selectedFile' | 'selectedFileReadOptions'>;
  copyPathLabel: string;
  files: ReturnType<typeof useRuntimeAPIs>['files'];
  isMobile: boolean;
  openInAppMenuItems: React.ReactNode;
  pathLabelCopies: boolean;
  t: ReturnType<typeof useI18n>['t'];
}) {
  const { copiedContent, copiedPath, copyContents, copyPath } = clipboard;
  const { exportDocument } = fileAssets;
  const { canCopy, canCopyPath, isMarkdown, isTable } = fileKinds;
  const { selectedFile, selectedFileReadOptions } = tabs;
  if (!selectedFile) return [];
    const downloadSelectedFile = () => {
      const fn = files.downloadFile;
      if (fn) void fn(selectedFile.path, selectedFileReadOptions).catch((error) => {
        console.error('Download failed:', error);
        toast.error(t('sidebarFilesTree.toast.operationFailed'));
      });
    };

    const fileActions: ToolbarGroup = [
      isDesktopLocalOriginActive() && {
        id: 'open-in-app',
        label: t('filesView.editor.openInDesktopApp'),
        icon: 'external-link',
        menu: openInAppMenuItems,
      },
      canCopy && {
        id: 'copy-contents',
        label: t('filesView.editor.copyFileContents'),
        icon: 'file-copy',
        done: copiedContent,
        onSelect: () => void copyContents(false),
        onMenuSelect: () => void copyContents(true),
      },
      canCopyPath && !pathLabelCopies && {
        id: 'copy-path',
        label: copyPathLabel,
        icon: 'link',
        done: copiedPath,
        onSelect: () => void copyPath(false),
        onMenuSelect: () => void copyPath(true),
      },
      Boolean(files.downloadFile) && {
        id: 'download',
        label: t('filesView.editor.saveFile'),
        icon: 'download',
        onSelect: downloadSelectedFile,
      },
      isMarkdown && {
        id: 'export-word',
        label: t('filesView.export.word'),
        icon: 'download',
        onSelect: () => void exportDocument('docx'),
      },
      isMarkdown && !isMobile && {
        id: 'export-pdf',
        label: t('filesView.export.pdf'),
        icon: 'download',
        onSelect: () => void exportDocument('pdf'),
      },
      isTable && {
        id: 'export-excel',
        label: t('filesView.export.excel'),
        icon: 'download',
        onSelect: () => void exportDocument('xlsx'),
      },
    ];

  return fileActions;
}
