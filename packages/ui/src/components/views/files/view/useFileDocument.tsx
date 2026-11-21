import React from 'react';
import { type FileStatSnapshot } from '../../fileStatChange';
import { type FileLineEnding } from '../../fileEditorContent';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { type useFileScope } from './useFileScope';

export function useFileDocument({ scope }: {
  scope: Pick<ReturnType<typeof useFileScope>, 'root'>;
}) {
  const { root } = scope;
  const [artifactSize, setArtifactSize] = React.useState<number | null>(null);
  const [fileContent, setFileContent] = React.useState<string>('');
  const [fileLoading, setFileLoading] = React.useState(false);
  const [fileError, setFileError] = React.useState<string | null>(null);
  const [desktopImageSrc, setDesktopImageSrc] = React.useState<string>('');

  const [loadedFilePath, setLoadedFilePath] = React.useState<string | null>(null);
  const loadedFilePathRef = React.useRef(loadedFilePath);
  loadedFilePathRef.current = loadedFilePath;
  const pendingPathMoveRef = React.useRef<{ from: string; to: string } | null>(null);
  const [documentPathAlias, setDocumentPathAlias] = React.useState<{ path: string; documentPath: string } | null>(null);
  const editorDocumentPath = documentPathAlias && documentPathAlias.path === loadedFilePath
    ? documentPathAlias.documentPath
    : loadedFilePath;
  const [failedFilePath, setFailedFilePath] = React.useState<string | null>(null);
  const missingSeenPathRef = React.useRef<string | null>(null);
  const filePositionKey = JSON.stringify([getRuntimeKey(), root, editorDocumentPath]);

  const [loadedFileLineEnding, setLoadedFileLineEnding] = React.useState<FileLineEnding>('\n');
  const lastLoadedFileStatRef = React.useRef<FileStatSnapshot | null>(null);
  const lastLoadedFileContentRef = React.useRef('');
  const lastLoadedFileRevisionRef = React.useRef(0);
  const activeFileLoadIdRef = React.useRef(0);
  const loadingFilePathRef = React.useRef<string | null>(null);
  const [fileContentRevision, setFileContentRevision] = React.useState(0);
  const [contentDetectedBinary, setContentDetectedBinary] = React.useState(false);

  return { artifactSize, setArtifactSize, fileContent, setFileContent, fileLoading, setFileLoading, fileError, setFileError, desktopImageSrc, setDesktopImageSrc, loadedFilePath, setLoadedFilePath, loadedFilePathRef, pendingPathMoveRef, setDocumentPathAlias, editorDocumentPath, failedFilePath, setFailedFilePath, missingSeenPathRef, filePositionKey, loadedFileLineEnding, setLoadedFileLineEnding, lastLoadedFileStatRef, lastLoadedFileContentRef, lastLoadedFileRevisionRef, activeFileLoadIdRef, loadingFilePathRef, fileContentRevision, setFileContentRevision, contentDetectedBinary, setContentDetectedBinary };
}
