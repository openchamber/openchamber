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
  // Set when a move or rename lands on the loaded file (`lib/filePathMoves.ts`):
  // once the tabs point at `to`, the editor adopts it with its unsaved edits
  // instead of re-reading the file.
  const pendingPathMoveRef = React.useRef<{ from: string; to: string } | null>(null);
  // Editors are keyed by the path the file was opened under, so adopting a
  // moved path does not remount them and drop their undo history or edits.
  const [documentPathAlias, setDocumentPathAlias] = React.useState<{ path: string; documentPath: string } | null>(null);
  const editorDocumentPath = documentPathAlias && documentPathAlias.path === loadedFilePath
    ? documentPathAlias.documentPath
    : loadedFilePath;
  // The path whose last read failed. Requests waiting for that file to load
  // (a line jump, a focus) end here instead of waiting forever.
  const [failedFilePath, setFailedFilePath] = React.useState<string | null>(null);
  // The path the open-file poll saw missing since its last load; only that
  // observation lets the poll reload a failed file once it is back.
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
