import { matchesRankQuery } from '@/lib/search/fuzzySearch';
import React from 'react';

import { toast } from '@/components/ui';
import { Icon } from '@/components/icon/Icon';
import { Textarea } from '@/components/ui/textarea';
import { KnowledgeCard } from './KnowledgeCard';
import { useI18n } from '@/lib/i18n';
import { PROJECT_NOTE_BODY_MAX_LENGTH, type ProjectNote, type ProjectRef } from '@/lib/projectContextApi';
import { cn } from '@/lib/utils';
import { useProjectContextStore } from '@/stores/useProjectContextStore';
import { useUIStore } from '@/stores/useUIStore';

const NOTE_SAVE_DEBOUNCE_MS = 400;

/**
 * One note, edited in place.
 *
 * The draft is local and debounced: writing straight through on every keystroke
 * would put a request behind every character, and re-reading the store on every
 * render would fight the caret. The stored body is adopted only while the
 * editor is untouched since its last save, so a concurrent write from another
 * surface reaches an idle row without eating an active one.
 */
const NoteRow: React.FC<{
  note: ProjectNote;
  pinned: boolean;
  expanded: boolean;
  onToggleExpanded: () => void;
  onSaveBody: (body: string) => void;
  onTogglePinned: () => void;
  onDelete: () => void;
}> = ({ note, pinned, expanded, onToggleExpanded, onSaveBody, onTogglePinned, onDelete }) => {
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
      // the row stays visible and the user can either restore it or delete it.
      if (!draft.trim()) {
        return;
      }
      lastSavedRef.current = draft;
      onSaveBody(draft);
    }, NOTE_SAVE_DEBOUNCE_MS);

    return cancelDebounce;
  }, [cancelDebounce, draft, onSaveBody]);

  React.useEffect(() => cancelDebounce, [cancelDebounce]);

  const handleBlur = React.useCallback(() => {
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
    onSaveBody(draft);
  }, [cancelDebounce, draft, onSaveBody]);

  const sourceLabel = note.source === 'selection'
    ? t('rightSidebar.contextNotesTodo.notes.source.selection')
    : note.source === 'agent'
      ? t('rightSidebar.contextNotesTodo.notes.source.agent')
      : null;

  return (
    <KnowledgeCard
      expanded={expanded}
      onToggleExpanded={onToggleExpanded}
      expandLabel={t('rightSidebar.contextNotesTodo.notes.actions.expand')}
      footer={sourceLabel ? (
        <span className="typography-micro text-muted-foreground">{sourceLabel}</span>
      ) : null}
      actions={(
        <>
          <button
            type="button"
            onClick={onTogglePinned}
            className={cn(
              'inline-flex h-6 w-6 items-center justify-center rounded-md hover:bg-interactive-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
              pinned ? 'text-primary' : 'text-muted-foreground hover:text-foreground'
            )}
            aria-pressed={pinned}
            aria-label={pinned
              ? t('rightSidebar.contextNotesTodo.notes.actions.unpin')
              : t('rightSidebar.contextNotesTodo.notes.actions.pin')}
            title={pinned
              ? t('rightSidebar.contextNotesTodo.notes.actions.unpin')
              : t('rightSidebar.contextNotesTodo.notes.actions.pin')}
          >
            {/* Filled means pinned, outline means "pin this" — the same
                language the work status panel uses. */}
            <Icon name={pinned ? 'pushpin-2-fill' : 'pushpin'} className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={onDelete}
            className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-interactive-hover/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
            aria-label={t('rightSidebar.contextNotesTodo.notes.actions.delete')}
            title={t('rightSidebar.contextNotesTodo.notes.actions.delete')}
          >
            <Icon name="delete-bin" className="h-3.5 w-3.5" />
          </button>
        </>
      )}
    >
      {expanded ? (
        <Textarea
          simple
          autoFocus
          rows={Math.min(20, Math.max(3, draft.split('\n').length + 1))}
          value={draft}
          onChange={(event) => setDraft(event.target.value.slice(0, PROJECT_NOTE_BODY_MAX_LENGTH))}
          onBlur={handleBlur}
          className="min-h-0 w-full resize-none bg-transparent p-0 typography-ui-label leading-normal text-foreground focus-visible:outline-none focus-visible:ring-0"
        />
      ) : (
        <p className="line-clamp-3 whitespace-pre-wrap break-words typography-ui-label leading-normal text-foreground" title={draft}>
          {draft}
        </p>
      )}
    </KnowledgeCard>
  );
};

/**
 * Free-form project notes, one entry per note.
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
}> = ({ projectRef, notes, disabled, query, pinnedNoteIds, onTogglePinned }) => {
  const { t } = useI18n();
  const [composerText, setComposerText] = React.useState('');
  // One at a time on purpose: notes can run to 3000 characters each, and
  // letting several stand open turns the tab into one unbroken wall of text.
  const [expandedNoteId, setExpandedNoteId] = React.useState<string | null>(null);
  const notesPanelHeight = useUIStore((state) => state.notesPanelHeight);
  const setNotesPanelHeight = useUIStore((state) => state.setNotesPanelHeight);
  const createNote = useProjectContextStore((state) => state.createNote);
  const saveNoteBody = useProjectContextStore((state) => state.saveNoteBody);
  const deleteNote = useProjectContextStore((state) => state.deleteNote);

  const visibleNotes = React.useMemo(
    () => notes.filter((note) => matchesRankQuery([note.body], query)),
    [notes, query],
  );

  // The store keeps the failure reason; without passing it through, every
  // failure looks identical to the user and tells them nothing about the cause.
  const reportFailure = React.useCallback((message: string) => {
    const detail = useProjectContextStore.getState().getEntry(projectRef).error;
    toast.error(message, detail ? { description: detail } : undefined);
  }, [projectRef]);

  const handleAdd = React.useCallback(async () => {
    const body = composerText.trim();
    if (!body) {
      return;
    }
    const created = await createNote(projectRef, { body });
    if (!created) {
      reportFailure(t('rightSidebar.contextNotesTodo.toast.createNoteFailed'));
      return;
    }
    setComposerText('');
  }, [composerText, createNote, projectRef, reportFailure, t]);

  const handleDelete = React.useCallback(
    async (noteId: string) => {
      const ok = await deleteNote(projectRef, noteId);
      if (!ok) {
        reportFailure(t('rightSidebar.contextNotesTodo.toast.deleteNoteFailed'));
      }
    },
    [deleteNote, projectRef, reportFailure, t]
  );

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

  return (
    <div className="space-y-2">
      {/* Counter and add live in the textarea's own footer slot: beside it they
          cost width the panel does not have and leave the button floating
          against a tall field. */}
      <Textarea
        value={composerText}
        onChange={(event) => setComposerText(event.target.value.slice(0, PROJECT_NOTE_BODY_MAX_LENGTH))}
        placeholder={t('rightSidebar.contextNotesTodo.notes.placeholder')}
        resizedHeight={notesPanelHeight}
        onResizeHeightChange={setNotesPanelHeight}
        useScrollShadow
        scrollShadowSize={56}
        disabled={disabled}
        endSlot={(
          <>
            <span className="typography-meta text-muted-foreground">
              {composerText.length}/{PROJECT_NOTE_BODY_MAX_LENGTH}
            </span>
            <button
              type="button"
              onClick={() => void handleAdd()}
              disabled={disabled || composerText.trim().length === 0}
              className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-interactive-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 disabled:cursor-not-allowed disabled:opacity-40"
              aria-label={t('rightSidebar.contextNotesTodo.notes.addAria')}
              title={t('rightSidebar.contextNotesTodo.notes.addAria')}
            >
              <Icon name="add" className="h-4 w-4" />
            </button>
          </>
        )}
      />

      {/* No frame around the list: each note is a bordered card, and an outer
          border sitting flush against them read as lines joining the cards. */}
      <div>
        {visibleNotes.length === 0 ? (
          <p className="typography-meta text-muted-foreground">
            {query.trim()
              ? t('rightSidebar.contextNotesTodo.search.noResults', { query: query.trim() })
              : t('rightSidebar.contextNotesTodo.notes.empty')}
          </p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {visibleNotes.map((note) => (
              <NoteRow
                key={note.id}
                note={note}
                pinned={pinnedNoteIds.has(note.id)}
                expanded={expandedNoteId === note.id}
                onToggleExpanded={() => setExpandedNoteId((current) => (current === note.id ? null : note.id))}
                onSaveBody={(body) => handleSaveBody(note.id, body)}
                onTogglePinned={() => void handleTogglePinned(note.id, !pinnedNoteIds.has(note.id))}
                onDelete={() => void handleDelete(note.id)}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
};
