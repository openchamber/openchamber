import React from 'react';
import { useUIStore } from '@/stores/useUIStore';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useI18n } from '@/lib/i18n';
import { DiagramEditor, type DiagramEditorHandle } from '@/components/diagram';
import { Icon } from '@/components/icon/Icon';

export function DiagramView() {
  const { t } = useI18n();
  const { files } = useRuntimeAPIs();

  const [filePath, setFilePath] = React.useState<string | null>(null);
  const [xml, setXml] = React.useState('');
  const [loading, setLoading] = React.useState(true);
  const editorRef = React.useRef<DiagramEditorHandle>(null);
  const loadFileRef = React.useRef<((path: string) => Promise<void>) | null>(null);

  React.useEffect(() => {
    const pending = useUIStore.getState().consumePendingDiagramFile();
    if (pending && loadFileRef.current) {
      loadFileRef.current(pending);
    }
  }, []);

  const loadFile = React.useCallback(async (path: string) => {
    setLoading(true);
    setFilePath(path);
    try {
      const result = await files?.readFile?.(path);
      if (result) {
        setXml(result.content);
      }
    } catch {
      setXml('');
    } finally {
      setLoading(false);
    }
  }, [files]);

  loadFileRef.current = loadFile;

  const fileName = filePath ? filePath.split('/').pop() || filePath : '';

  if (!filePath) {
    return (
      <div className="flex h-full items-center justify-center p-3">
        <div className="typography-ui text-muted-foreground">
          {t('filesView.editor.pickFileFromTree')}
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center p-3">
        <Icon name="loader-4" className="size-4 animate-spin" />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border/30 px-3 py-1.5">
        <Icon name="file" className="size-4 shrink-0 text-muted-foreground" />
        <span className="typography-ui text-muted-foreground truncate flex-1">{fileName}</span>
        <button
          type="button"
          onClick={() => useUIStore.getState().setActiveMainTab('chat')}
          className="size-6 flex items-center justify-center rounded-md text-muted-foreground hover:bg-interactive-hover/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          title={t('filesView.diagram.closeDiagramView')}
        >
          <Icon name="close" className="size-4" />
        </button>
      </div>
      <div className="flex-1 min-h-0">
        <DiagramEditor
          ref={editorRef}
          xml={xml}
          className="h-full"
          onChange={(newXml) => {
            if (filePath && files?.writeFile && newXml !== xml) {
              files.writeFile(filePath, newXml).catch(() => {});
            }
          }}
        />
      </div>
    </div>
  );
}
