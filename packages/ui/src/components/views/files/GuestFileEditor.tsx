import React from 'react';
import { GUEST_FILE_EDITOR_CONTENT_MAX, type FileEditorContentKind, type FileEditorDocument } from '@openchamber/sdk';

import { PluginPane } from '@/components/layout/PluginPane';
import { createGuestFileChannel, type GuestFileChannel } from '@/lib/guests/file-editor-channel';
import { useI18n } from '@/lib/i18n';
import { pluginModeFromId } from '@/lib/surfaces/modes';
import type { FileCanvasHandle, FileCanvasRead } from './fileCanvas';

type GuestFileEditorProps = {
  guestId: string;
  editorId: string;
  /** The editor's declared title, for messages about it. */
  title: string;
  /** `contributes.fileEditors[].content`: what the editor is handed and must hand back. */
  contentKind: FileEditorContentKind;
  path: string;
  /** Text editors: the document at mount. The caller remounts (`key`) to hand over content the editor did not author. */
  content: string;
  /** Binary editors: reads the file's bytes at mount. */
  loadBytes: () => Promise<Uint8Array<ArrayBuffer>>;
  readOnly: boolean;
  onDirtyChange: (dirty: boolean) => void;
  /** Called on every change to the document itself. */
  onEdit: () => void;
  /** The user pressed Cmd/Ctrl+S inside the editor frame. */
  onSaveRequest: () => void;
  onUnsupported: () => void;
  /** A binary file over `GUEST_FILE_EDITOR_CONTENT_MAX` bytes; the editor never loads. */
  onTooLarge: () => void;
  /** The bytes could not be read. */
  onLoadFailed: () => void;
};

const fileNameOf = (filePath: string): string => filePath.slice(filePath.replace(/\\/g, '/').lastIndexOf('/') + 1) || filePath;

/**
 * An extension's file editor (`contributes.fileEditors`) in the Files view.
 * The frame is a sandboxed `PluginPane surface="file"`; the host keeps the
 * file, and this component turns the frame's channel into the canvas handle
 * FilesView saves through. A text editor gets the draft it mounted with; a
 * binary editor first reads the file's bytes and loads the frame once they
 * are here.
 */
export const GuestFileEditor = React.forwardRef<FileCanvasHandle, GuestFileEditorProps>(
  function GuestFileEditor(props, ref) {
    const { guestId, editorId, title, contentKind, path, content, readOnly } = props;
    const { t } = useI18n();
    const eventsRef = React.useRef(props);
    eventsRef.current = props;

    const openChannel = React.useCallback((document: FileEditorDocument) => createGuestFileChannel(document, {
      onChange: (change) => {
        if (change.edited) eventsRef.current.onEdit();
        eventsRef.current.onDirtyChange(change.dirty);
      },
      onSave: () => eventsRef.current.onSaveRequest(),
      onUnsupported: () => eventsRef.current.onUnsupported(),
    }), []);

    const [channel, setChannel] = React.useState<GuestFileChannel | null>(() => (
      contentKind === 'text' ? openChannel({ path, name: fileNameOf(path), readOnly, encoding: 'text', content }) : null
    ));

    // The file this mount edits is fixed; the caller remounts this component
    // for a different file or to reload it from disk.
    const [mounted] = React.useState(() => ({ contentKind, path, readOnly }));
    React.useEffect(() => {
      if (mounted.contentKind !== 'binary') return;
      let cancelled = false;
      void eventsRef.current.loadBytes().then((bytes) => {
        if (cancelled) return;
        if (bytes.byteLength > GUEST_FILE_EDITOR_CONTENT_MAX) {
          eventsRef.current.onTooLarge();
          return;
        }
        setChannel(openChannel({ path: mounted.path, name: fileNameOf(mounted.path), readOnly: mounted.readOnly, encoding: 'binary', bytes }));
      }, () => {
        if (!cancelled) eventsRef.current.onLoadFailed();
      });
      return () => { cancelled = true; };
    }, [mounted, openChannel]);

    React.useImperativeHandle(ref, () => ({
      getContent: async (purpose): Promise<FileCanvasRead> => {
        const failed: FileCanvasRead = { ok: false, message: t('filesView.fileEditor.snapshotFailed', { editor: title }) };
        if (!channel) return failed;
        try {
          const snapshot = await channel.requestSnapshot(purpose);
          // An editor must hand back what it declared; text for a binary file
          // (or bytes for a text one) would be written as the wrong thing.
          if ('bytes' in snapshot) {
            return contentKind === 'binary' ? { ok: true, snapshot: { bytes: snapshot.bytes, signature: snapshot.version } } : failed;
          }
          return contentKind === 'text' ? { ok: true, snapshot: { content: snapshot.content, signature: snapshot.version } } : failed;
        } catch {
          return failed;
        }
      },
      markSaved: (signature) => {
        channel?.markSaved(signature);
        // The editor answers `file-saved` with its own state; edits made while
        // the write ran turn this back to dirty.
        eventsRef.current.onDirtyChange(false);
      },
    }), [channel, contentKind, t, title]);

    const fileEditor = React.useMemo(() => (channel ? { editorId, channel } : null), [channel, editorId]);

    if (!fileEditor) {
      return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">{t('common.loading')}</div>;
    }
    return <PluginPane mode={pluginModeFromId(guestId)} surface="file" fileEditor={fileEditor} />;
  },
);
