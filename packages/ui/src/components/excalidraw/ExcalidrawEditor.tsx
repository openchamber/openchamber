import React from 'react';
import { Excalidraw } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import type { AppState, BinaryFiles } from '@excalidraw/excalidraw/types';
import type { OrderedExcalidrawElement } from '@excalidraw/excalidraw/element/types';

import { useOptionalThemeSystem } from '@/contexts/useThemeSystem';
import { useI18n } from '@/lib/i18n';
import { excalidrawLangCode, excalidrawSceneSignature, type ExcalidrawFormat } from './scene';
import { openExcalidrawDocument, serializeExcalidrawDocument } from './document';

export type ExcalidrawEditorHandle = {
  getContent: () => string | null;
  markSaved: () => void;
};

type ExcalidrawEditorProps = {
  content: string;
  format: ExcalidrawFormat;
  onDirtyChange?: (dirty: boolean) => void;
  onUnsupported?: () => void;
};

type LiveScene = {
  elements: readonly OrderedExcalidrawElement[];
  appState: AppState;
  files: BinaryFiles;
};

export const ExcalidrawEditor = React.forwardRef<ExcalidrawEditorHandle, ExcalidrawEditorProps>(
  function ExcalidrawEditor({ content, format, onDirtyChange, onUnsupported }, ref) {
    const { locale } = useI18n();
    const themeSystem = useOptionalThemeSystem();
    const onDirtyChangeRef = React.useRef(onDirtyChange);
    onDirtyChangeRef.current = onDirtyChange;
    const onUnsupportedRef = React.useRef(onUnsupported);
    onUnsupportedRef.current = onUnsupported;

    const theme = themeSystem?.currentTheme.metadata.variant === 'dark' ? 'dark' : 'light';

    const [parsed] = React.useState(() => openExcalidrawDocument(content, format));
    const liveSceneRef = React.useRef<LiveScene | null>(null);
    const savedSignatureRef = React.useRef<string | null>(
      parsed ? excalidrawSceneSignature(parsed.scene.elements, parsed.scene.appState) : null,
    );
    const isDirtyRef = React.useRef(false);
    const reportedUnsupportedRef = React.useRef(false);

    React.useEffect(() => {
      if (parsed || reportedUnsupportedRef.current) return;
      reportedUnsupportedRef.current = true;
      onUnsupportedRef.current?.();
    }, [parsed]);

    React.useImperativeHandle(ref, () => ({
      getContent: () => {
        const scene = liveSceneRef.current;
        if (!scene || !parsed) return null;
        return serializeExcalidrawDocument(parsed.container, scene);
      },
      markSaved: () => {
        const scene = liveSceneRef.current;
        if (!scene) return;
        savedSignatureRef.current = excalidrawSceneSignature(scene.elements, scene.appState);
        if (!isDirtyRef.current) return;
        isDirtyRef.current = false;
        onDirtyChangeRef.current?.(false);
      },
    }), [parsed]);

    const handleChange = React.useCallback(
      (elements: readonly OrderedExcalidrawElement[], appState: AppState, files: BinaryFiles) => {
        liveSceneRef.current = { elements, appState, files };
        const dirty = excalidrawSceneSignature(elements, appState) !== savedSignatureRef.current;
        if (dirty === isDirtyRef.current) return;
        isDirtyRef.current = dirty;
        onDirtyChangeRef.current?.(dirty);
      },
      [],
    );

    if (!parsed) return null;

    return (
      <div className="h-full w-full">
        <Excalidraw
          initialData={parsed.scene}
          onChange={handleChange}
          theme={theme}
          langCode={excalidrawLangCode(locale)}
          UIOptions={{
            canvasActions: {
              loadScene: false,
              saveToActiveFile: false,
              saveAsImage: false,
              export: false,
              toggleTheme: null,
            },
          }}
          detectScroll={false}
        />
      </div>
    );
  },
);
