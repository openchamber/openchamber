
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
  onCloseFile?: (path: string) => void;
}

export type TextViewMode = 'view' | 'edit';
export type PreviewViewMode = 'preview' | 'edit';
