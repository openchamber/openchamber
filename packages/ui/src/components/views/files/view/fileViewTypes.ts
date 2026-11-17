
export type FileNode = {
  name: string;
  path: string;
  type: 'file' | 'directory';
  extension?: string;
  relativePath?: string;
};

export type SelectedLineRange = {
  start: number;
  end: number;
};

export interface FilesViewProps {
  visible?: boolean;
  mode?: 'full' | 'editor-only';
  onCloseFile?: (path: string) => void;
}

export type TextViewMode = 'view' | 'edit';
export type PreviewViewMode = 'preview' | 'edit';

export type FilesViewOptions = Required<Pick<FilesViewProps, 'mode' | 'visible'>> & Pick<FilesViewProps, 'onCloseFile'>;
