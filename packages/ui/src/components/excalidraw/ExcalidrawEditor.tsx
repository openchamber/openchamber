import React from 'react';
import { Excalidraw } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import './excalidraw-theme.css';
import type { AppState, BinaryFiles } from '@excalidraw/excalidraw/types';
import type { OrderedExcalidrawElement } from '@excalidraw/excalidraw/element/types';

import { useOptionalThemeSystem } from '@/contexts/useThemeSystem';
import { useI18n } from '@/lib/i18n';
import { createExcalidrawSaveTracker, excalidrawLangCode, excalidrawSceneSignature, type ExcalidrawFormat } from './scene';
import { openExcalidrawDocument, serializeExcalidrawDocument } from './document';

/** One read of the live scene: the document to write and the scene it came from. */
export type ExcalidrawSnapshot = { content: string; signature: string };

export type ExcalidrawEditorHandle = {
  getContent: () => ExcalidrawSnapshot | null;
  /**
   * Records `signature` (from the snapshot that was written) as saved. Strokes
   * drawn while the write ran differ from it, so the canvas stays dirty.
   */
  markSaved: (signature: string) => void;
};

type ExcalidrawEditorProps = {
  content: string;
  format: ExcalidrawFormat;
  onDirtyChange?: (dirty: boolean) => void;
  /** Called on every change to the drawing (not on scroll or selection). */
  onEdit?: () => void;
  onUnsupported?: () => void;
};

type LiveScene = {
  elements: readonly OrderedExcalidrawElement[];
  appState: AppState;
  files: BinaryFiles;
};

export const ExcalidrawEditor = React.forwardRef<ExcalidrawEditorHandle, ExcalidrawEditorProps>(
  function ExcalidrawEditor({ content, format, onDirtyChange, onEdit, onUnsupported }, ref) {
    const { locale } = useI18n();
    const themeSystem = useOptionalThemeSystem();
    const onDirtyChangeRef = React.useRef(onDirtyChange);
    onDirtyChangeRef.current = onDirtyChange;
    const onUnsupportedRef = React.useRef(onUnsupported);
    onUnsupportedRef.current = onUnsupported;
    const onEditRef = React.useRef(onEdit);
    onEditRef.current = onEdit;

    const theme = themeSystem?.currentTheme.metadata.variant === 'dark' ? 'dark' : 'light';

    const [parsed] = React.useState(() => openExcalidrawDocument(content, format));
    const liveSceneRef = React.useRef<LiveScene | null>(null);
    const [saveTracker] = React.useState(() => createExcalidrawSaveTracker(
      parsed ? excalidrawSceneSignature(parsed.scene.elements, parsed.scene.appState) : null,
    ));
    const isDirtyRef = React.useRef(false);

    const reportDirty = React.useCallback((dirty: boolean) => {
      if (dirty === isDirtyRef.current) return;
      isDirtyRef.current = dirty;
      onDirtyChangeRef.current?.(dirty);
    }, []);
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
        return {
          content: serializeExcalidrawDocument(parsed.container, scene),
          signature: excalidrawSceneSignature(scene.elements, scene.appState),
        };
      },
      markSaved: (signature) => reportDirty(saveTracker.markSaved(signature)),
    }), [parsed, reportDirty, saveTracker]);

    const handleChange = React.useCallback(
      (elements: readonly OrderedExcalidrawElement[], appState: AppState, files: BinaryFiles) => {
        liveSceneRef.current = { elements, appState, files };
        const { edited, dirty } = saveTracker.observe(excalidrawSceneSignature(elements, appState));
        if (edited) onEditRef.current?.();
        reportDirty(dirty);
      },
      [reportDirty, saveTracker],
    );

    if (!parsed) return null;

    return (
      <div className="oc-excalidraw h-full w-full">
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
