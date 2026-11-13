import { matchesRankQuery } from '@/lib/search/fuzzySearch';
import React from 'react';

import { toast } from '@/components/ui';
import { SimpleMarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { KnowledgeCard } from './KnowledgeCard';
import { KnowledgeComposer } from './KnowledgeComposer';
import { KnowledgeEntryView } from './KnowledgeEntryView';
import { KnowledgeSplit } from './KnowledgeSplit';
import { KnowledgeMenu, KnowledgePinToggle } from './KnowledgeActions';
import { formatKnowledgeDate, splitNoteTitle } from './knowledgeFormat';
import { noteDeleteKey, scheduleKnowledgeDelete, usePendingKnowledgeDeletes } from './pendingKnowledgeDeletes';
import { useI18n } from '@/lib/i18n';
import { PROJECT_NOTE_BODY_MAX_LENGTH, type ProjectNote, type ProjectRef } from '@/lib/projectContextApi';
import { openSessionLink } from '@/lib/router/openSessionFromRoute';
import { useProjectContextStore } from '@/stores/useProjectContextStore';

const NOTE_SAVE_DEBOUNCE_MS = 400;

/** Lazy: the editor brings CodeMirror, and most panel visits never open a note. */
const NoteEditor = React.lazy(() => import('./NoteEditor').then((module) => ({ default: module.NoteEditor })));

/** Past this the card preview is cut, and fades out so the cut is visible. */
const PREVIEW_FADE_MIN_CHARS = 180;
const PREVIEW_FADE_MIN_LINES = 4;
const PREVIEW_FADE_MASK = 'linear-gradient(to bottom, black 55%, transparent)';
const PREVIEW_FADE_STYLE: React.CSSProperties = { maskImage: PREVIEW_FADE_MASK, WebkitMaskImage: PREVIEW_FADE_MASK };

/** Source, date and pin state: the card footer and the open note's toolbar. */
const NoteMeta: React.FC<{ note: ProjectNote; pinned: boolean }> = ({ note, pinned }) => {
  const { t } = useI18n();
  const sourceLabel = note.source === 'selection'
    ? t('rightSidebar.contextNotesTodo.notes.source.selection')
    : note.source === 'agent'
      ? t('rightSidebar.contextNotesTodo.notes.source.agent')
      : null;
  const origin = note.origin;

  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 typography-micro text-muted-foreground">
      {sourceLabel && origin ? (
        // The note keeps the message it came from; the label opens it.
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            void openSessionLink(origin.sessionId, origin.messageId ?? null);
          }}
          className="text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          title={t('rightSidebar.contextNotesTodo.notes.source.open')}
        >
          {sourceLabel}
        </button>
      ) : sourceLabel ? (
        <span>{sourceLabel}</span>
      ) : null}
      {sourceLabel ? <span aria-hidden="true">·</span> : null}
      <span>{formatKnowledgeDate(note.updatedAt || note.createdAt)}</span>
      {pinned ? (
        <>
          <span aria-hidden="true">·</span>
          <span className="text-primary">{t('rightSidebar.contextNotesTodo.pin.attached')}</span>
        </>
      ) : null}
    </span>
  );
};

/** One note in the list. Read-only; a click opens it. */
const NoteCard: React.FC<{
  note: ProjectNote;
  pinned: boolean;
  onOpen: () => void;
  onTogglePinned: () => void;
  onDelete: () => void;
  selected: boolean;
}> = ({ note, pinned, onOpen, onTogglePinned, onDelete , selected}) => {
  const { t } = useI18n();
  const { title, rest } = React.useMemo(() => splitNoteTitle(note.body), [note.body]);
  const fadePreview = rest.length > PREVIEW_FADE_MIN_CHARS || rest.split('\n').length > PREVIEW_FADE_MIN_LINES;

  return (
    <KnowledgeCard
      selected={selected}
      entryId={note.id}
      onOpen={onOpen}
      label={title || t('rightSidebar.contextNotesTodo.notes.actions.expand')}
      header={(
        <span className="min-w-0 flex-1 truncate typography-ui-label font-medium text-foreground" dir="auto" title={title}>
          {title}
        </span>
      )}
      actions={(
        <>
          <KnowledgePinToggle pinned={pinned} onToggle={onTogglePinned} />
          <KnowledgeMenu
            items={[{
              id: 'delete',
              label: t('rightSidebar.contextNotesTodo.notes.actions.delete'),
              destructive: true,
              onSelect: onDelete,
            }]}
          />
        </>
      )}
      footer={<NoteMeta note={note} pinned={pinned} />}
    >
      {rest ? (
        <div
          className="max-h-[4.5lh] overflow-hidden typography-meta text-muted-foreground"
          style={fadePreview ? PREVIEW_FADE_STYLE : undefined}
          // A link in the preview opens the link, not the note.
          onClick={(event) => {
            if (event.target instanceof Element && event.target.closest('a')) event.stopPropagation();
          }}
        >
          <SimpleMarkdownRenderer content={rest} className="typography-meta" enableFileReferences={false} />
        </div>
      ) : null}
    </KnowledgeCard>
  );
};

/**
 * An open note, in place of the list or beside it. `NoteEditor` is always
 * editable and always reads as formatted text, so there is no read mode to
 * click out of.
 *
 * The draft is local and debounced: writing straight through on every keystroke
 * would put a request behind every character, and re-reading the store on every
 * render would fight the caret. The stored body is adopted only while the
 * editor is untouched since its last save, so a concurrent write from another
 * surface (an agent, another window) reaches an idle note without eating an
 * active one.
 */
const NoteView: React.FC<{
  note: ProjectNote;
  pinned: boolean;
  onSaveBody: (noteId: string, body: string) => void;
  onTogglePinned: () => void;
  onDelete: () => void;
  onClose: () => void;
  showBack: boolean;
}> = ({ note, pinned, onSaveBody, onTogglePinned, onDelete, onClose , showBack}) => {
  const { t } = useI18n();
  const [draft, setDraft] = React.useState(note.body);
  const lastSavedRef = React.useRef(note.body);
  const debounceRef = React.useRef<number | null>(null);

  const cancelDebounce = React.useCallback(() => {
    if (debounceRef.current !== null) {
      window.clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
  }, []);

  React.useEffect(() => {
    if (note.body === lastSavedRef.current) {
      return;
    }
    if (draft !== lastSavedRef.current) {
      return;
    }
    lastSavedRef.current = note.body;
    setDraft(note.body);
  }, [draft, note.body]);

  React.useEffect(() => {
    if (draft === lastSavedRef.current) {
      return;
    }
    debounceRef.current = window.setTimeout(() => {
      debounceRef.current = null;
      // An empty body is a rejected write, not a delete. Leave it unsaved so
      // the user can either restore it or delete the note.
      if (!draft.trim()) {
        return;
      }
      lastSavedRef.current = draft;
      onSaveBody(note.id, draft);
    }, NOTE_SAVE_DEBOUNCE_MS);

    return cancelDebounce;
  }, [cancelDebounce, draft, note.id, onSaveBody]);

  // Leaving the note (back, Escape, another section) must not drop the last
  // keystrokes still waiting for the debounce.
  const flushRef = React.useRef<() => void>(() => {});
  flushRef.current = () => {
    cancelDebounce();
    if (draft === lastSavedRef.current) {
      return;
    }
    if (!draft.trim()) {
      // Restore rather than persist a blank: the server rejects it anyway.
      setDraft(lastSavedRef.current);
      return;
    }
    lastSavedRef.current = draft;
    onSaveBody(note.id, draft);
  };
  React.useEffect(() => () => flushRef.current(), []);

  return (
    <KnowledgeEntryView
      showBack={showBack}
      backLabel={t('rightSidebar.contextNotesTodo.notes.actions.back')}
      onClose={onClose}
      meta={<NoteMeta note={note} pinned={pinned} />}
      actions={(
        <>
          <KnowledgePinToggle alwaysVisible pinned={pinned} onToggle={onTogglePinned} />
          <KnowledgeMenu
            alwaysVisible
            items={[{
              id: 'delete',
              label: t('rightSidebar.contextNotesTodo.notes.actions.delete'),
              destructive: true,
              onSelect: onDelete,
            }]}
          />
        </>
      )}
    >
      <React.Suspense fallback={null}>
        <NoteEditor
          value={draft}
          onChange={setDraft}
          onBlur={() => flushRef.current()}
          ariaLabel={t('rightSidebar.contextNotesTodo.notes.editorLabel')}
          maxLength={PROJECT_NOTE_BODY_MAX_LENGTH}
        />
      </React.Suspense>
    </KnowledgeEntryView>
  );
};

/**
 * Free-form project notes: a list that never moves, and the open note in its
 * place.
 *
 * Notes are written through their own routes, so this section owns its writes
 * end to end — nothing here has to be persisted alongside todos.
 */
export const NotesSection: React.FC<{
  projectRef: ProjectRef;
  notes: ProjectNote[];
  disabled: boolean;
  query: string;
  pinnedNoteIds: ReadonlySet<string>;
  onTogglePinned: (noteId: string, pinned: boolean) => Promise<boolean>;
  /** The open note, owned by the panel so its back control can close it. */
  openNoteId: string | null;
  onOpenNote: (noteId: string | null) => void;
  /** Wide panel: the list and the open entry side by side. */
  split: boolean;
}> = ({ projectRef, notes, disabled, query, pinnedNoteIds, onTogglePinned, openNoteId, onOpenNote, split }) => {
  const { t } = useI18n();
  const createNote = useProjectContextStore((state) => state.createNote);
  const saveNoteBody = useProjectContextStore((state) => state.saveNoteBody);
  const deleteNote = useProjectContextStore((state) => state.deleteNote);
  const pendingDeletes = usePendingKnowledgeDeletes();

  const visibleNotes = React.useMemo(
    () => notes.filter((note) => (
      !pendingDeletes.has(noteDeleteKey(projectRef, note.id)) && matchesRankQuery([note.body], query)
    )),
    [notes, pendingDeletes, projectRef, query],
  );

  const openNote = React.useMemo(
    () => (openNoteId ? notes.find((note) => note.id === openNoteId) ?? null : null),
    [notes, openNoteId],
  );

  // A note deleted elsewhere (an agent, another window) closes if it was open.
  React.useEffect(() => {
    if (openNoteId && !openNote) onOpenNote(null);
  }, [onOpenNote, openNote, openNoteId]);

  // The store keeps the failure reason; without passing it through, every
  // failure looks identical to the user and tells them nothing about the cause.
  const reportFailure = React.useCallback((message: string) => {
    const detail = useProjectContextStore.getState().getEntry(projectRef).error;
    toast.error(message, detail ? { description: detail } : undefined);
  }, [projectRef]);

  const handleAdd = React.useCallback(async (body: string) => {
    const created = await createNote(projectRef, { body });
    if (!created) {
      reportFailure(t('rightSidebar.contextNotesTodo.toast.createNoteFailed'));
      return false;
    }
    return true;
  }, [createNote, projectRef, reportFailure, t]);

  const handleDelete = React.useCallback((noteId: string) => {
    if (openNoteId === noteId) onOpenNote(null);
    scheduleKnowledgeDelete({
      key: noteDeleteKey(projectRef, noteId),
      message: t('rightSidebar.contextNotesTodo.deleted.note'),
      undoLabel: t('rightSidebar.contextNotesTodo.undo'),
      run: () => deleteNote(projectRef, noteId),
      onFailure: () => reportFailure(t('rightSidebar.contextNotesTodo.toast.deleteNoteFailed')),
    });
  }, [deleteNote, onOpenNote, openNoteId, projectRef, reportFailure, t]);

  const handleTogglePinned = React.useCallback(
    async (noteId: string, pinned: boolean) => {
      const ok = await onTogglePinned(noteId, pinned);
      if (!ok) {
        reportFailure(t('rightSidebar.contextNotesTodo.toast.saveNotesFailed'));
      }
    },
    [onTogglePinned, reportFailure, t]
  );

  const handleSaveBody = React.useCallback(
    (noteId: string, body: string) => {
      void saveNoteBody(projectRef, noteId, body).then((ok: boolean) => {
        if (!ok) {
          reportFailure(t('rightSidebar.contextNotesTodo.toast.saveNotesFailed'));
        }
      });
    },
    [projectRef, reportFailure, saveNoteBody, t]
  );

  const openView = openNote ? (
    <NoteView
      key={openNote.id}
      note={openNote}
      pinned={pinnedNoteIds.has(openNote.id)}
      onSaveBody={handleSaveBody}
      onTogglePinned={() => void handleTogglePinned(openNote.id, !pinnedNoteIds.has(openNote.id))}
      onDelete={() => handleDelete(openNote.id)}
      showBack={!split}
      onClose={() => onOpenNote(null)}
    />
  ) : null;

  const list = (
    <div className="space-y-2">
      <KnowledgeComposer
        multiline
        placeholder={t('rightSidebar.contextNotesTodo.notes.placeholder')}
        addLabel={t('rightSidebar.contextNotesTodo.notes.addAria')}
        maxLength={PROJECT_NOTE_BODY_MAX_LENGTH}
        disabled={disabled}
        onSubmit={handleAdd}
      />

      {/* With no notes at all the composer's placeholder already says what
          goes here; only a search that finds nothing needs saying. */}
      {visibleNotes.length === 0 ? (
        query.trim() ? (
          <p className="px-1 typography-meta text-muted-foreground">
            {t('rightSidebar.contextNotesTodo.search.noResults', { query: query.trim() })}
          </p>
        ) : null
      ) : (
        <ul className="flex flex-col gap-1.5">
          {visibleNotes.map((note) => (
            <NoteCard
              key={note.id}
              selected={split && note.id === openNoteId}
              note={note}
              pinned={pinnedNoteIds.has(note.id)}
              onOpen={() => onOpenNote(note.id)}
              onTogglePinned={() => void handleTogglePinned(note.id, !pinnedNoteIds.has(note.id))}
              onDelete={() => handleDelete(note.id)}
            />
          ))}
        </ul>
      )}
    </div>
  );

  if (split) {
    return <KnowledgeSplit list={list} detail={openView} emptyLabel={t('rightSidebar.contextNotesTodo.notes.selectHint')} />;
  }
  return openView ?? list;
};
