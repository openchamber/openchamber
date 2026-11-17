import React from 'react';
import { GUEST_FILE_EDITOR_CONTENT_MAX, type FileEditorContentKind, type FileEditorDocument } from '@openchamber/sdk';

import { PluginPane } from '@/components/layout/PluginPane';
import { ContentLoadingState } from '@/components/ui/content-state';
import { createGuestFileChannel, type GuestFileChannel } from '@/lib/guests/file-editor-channel';
import { useI18n } from '@/lib/i18n';
import { pluginModeFromId } from '@/lib/surfaces/modes';
import type { FileCanvasHandle, FileCanvasRead } from './fileCanvas';

type GuestFileEditorProps = {
  guestId: string;
  editorId: string;
  title: string;
  contentKind: FileEditorContentKind;
  path: string;
  content: string;
  loadBytes: () => Promise<Uint8Array<ArrayBuffer>>;
  readOnly: boolean;
  onDirtyChange: (dirty: boolean) => void;
  onEdit: () => void;
  onSaveRequest: () => void;
  onUnsupported: () => void;
  onTooLarge: () => void;
  onLoadFailed: () => void;
};

const fileNameOf = (filePath: string): string => filePath.slice(filePath.replace(/\\/g, '/').lastIndexOf('/') + 1) || filePath;

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
        eventsRef.current.onDirtyChange(false);
      },
    }), [channel, contentKind, t, title]);

    const fileEditor = React.useMemo(() => (channel ? { editorId, channel } : null), [channel, editorId]);

    if (!fileEditor) {
      return <ContentLoadingState label={t('filesView.artifact.state.loading')} />;
    }
    return <PluginPane mode={pluginModeFromId(guestId)} surface="file" fileEditor={fileEditor} />;
  },
);
