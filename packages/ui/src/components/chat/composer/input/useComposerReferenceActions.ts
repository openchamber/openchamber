import type { useI18n } from '@/lib/i18n';
import type { useComposerSessionScope } from './useComposerSessionScope';
import type { useComposerRuntime } from './useComposerRuntime';
import type { useComposerReferencePickerState } from './useComposerReferencePickerState';
import type { useComposerReferencePicker } from './useComposerReferencePicker';
import type { useComposerReferenceDrafts } from './useComposerReferenceDrafts';
import type { useComposerMentionAttachments } from './useComposerMentionAttachments';
import type { useComposerLanguage } from './useComposerLanguage';
import type { useComposerFileIntake } from './useComposerFileIntake';
import type { useComposerEditorState } from './useComposerEditorState';
import type { useComposerDraftText } from './useComposerDraftText';
import type { useComposerColumn } from './useComposerColumn';
import type { useComposerAttachmentPreview } from './useComposerAttachmentPreview';
import React from 'react';
import { useUIStore } from '@/stores/useUIStore';
import type { AttachIssueRequest } from '@openchamber/sdk';
import { toast } from '@/components/ui';
import { isMobileSurfaceRuntime } from '@/lib/runtimeSurface';
import { openGuestSurface } from '@/lib/guests/open-surface';
import { guestPanelOpensHere } from '@/lib/guests/phone';
import { composerReferenceKey, withComposerReferences, type ComposerReference } from '../../composer/composerReferences';
import { referencesLinkedIn, referenceTextLink } from '../../composer/referenceLinks';
import { usePendingComposerReferences, resolveComposerReferenceHandoffTarget, type ComposerReferenceHandoff } from '../../composer/pendingComposerReferences';
import { trackerPresentation } from '@/lib/trackers/presentation';
import { trackerReferenceSource } from '@/components/references/referencePickerItems';
import type { ComposerTrackerPicker } from '../../composer/ui/ComposerAttachmentControls';
import { useGuestAttachItems } from '@/hooks/useGuestSurfaces';
import { openGuestWithItem } from '@/lib/guests/dialog-store';
import { useGuestsStore } from '@/lib/guests/store';
import { isGuestActive } from '@/lib/guests/capabilities';
import { pluginModeFromId } from '@/lib/surfaces/modes';
import { type ComposerChipTarget } from '../../composer/language/tokenize';
import { useOpenAttachment } from '../../message/useOpenAttachment';
import { findAttachmentPart, resolveAttachmentOpenTarget } from '@/lib/messages/attachmentPreview';

type Dependencies = {
    referenceDrafts: Pick<ReturnType<typeof useComposerReferenceDrafts>, 'setAttachDialogItem' | 'setAttachDialogGuestId' | 'handleGuestAttach' | 'updateLinkedReferences'>;
    sessionScope: Pick<ReturnType<typeof useComposerSessionScope>, 'currentDirectory' | 'attachedFiles' | 'pendingGuestIssue' | 'isBtwActive' | 'consumePendingGuestIssue' | 'currentSessionId' | 'newSessionDraftOpen' | 'newSessionDraft' | 'activeRuntimeKey' | 'pendingComposerReferenceCount'>;
    i18n: Pick<ReturnType<typeof useI18n>, 't'>;
    editorState: Pick<ReturnType<typeof useComposerEditorState>, 'composerRef'>;
    draftText: Pick<ReturnType<typeof useComposerDraftText>, 'composerText'>;
    column: Pick<ReturnType<typeof useComposerColumn>, 'columnPinned'>;
    language: Pick<ReturnType<typeof useComposerLanguage>, 'openSharedPageKey' | 'linkedReferences' | 'chipOpenRef' | 'setOpenSharedPageKey' | 'chatDraftIdentityKey'>;
    attachmentPreview: Pick<ReturnType<typeof useComposerAttachmentPreview>, 'handleShowAttachmentPreview'>;
    mentionAttachments: Pick<ReturnType<typeof useComposerMentionAttachments>, 'sanitizeAttachmentsForSend'>;
    fileIntake: Pick<ReturnType<typeof useComposerFileIntake>, 'insertCitationAtSelection'>;
    referencePicker: Pick<ReturnType<typeof useComposerReferencePicker>, 'trackerSources'>;
    referencePickerState: Pick<ReturnType<typeof useComposerReferencePickerState>, 'setReferencePicker'>;
    runtime: Pick<ReturnType<typeof useComposerRuntime>, 'isVSCode'>;
};

export function useComposerReferenceActions({
    referenceDrafts, sessionScope, i18n, editorState, draftText, column, language, attachmentPreview,
    mentionAttachments, fileIntake, referencePicker, referencePickerState, runtime,
}: Dependencies) {
    const {
        setAttachDialogItem, setAttachDialogGuestId, handleGuestAttach, updateLinkedReferences,
    } = referenceDrafts;
    const {
        currentDirectory, attachedFiles, pendingGuestIssue, isBtwActive, consumePendingGuestIssue,
        currentSessionId, newSessionDraftOpen, newSessionDraft, activeRuntimeKey,
        pendingComposerReferenceCount,
    } = sessionScope;
    const { t } = i18n;
    const { composerRef } = editorState;
    const { composerText } = draftText;
    const { columnPinned } = column;
    const {
        openSharedPageKey, linkedReferences, chipOpenRef, setOpenSharedPageKey, chatDraftIdentityKey,
    } = language;
    const { handleShowAttachmentPreview } = attachmentPreview;
    const { sanitizeAttachmentsForSend } = mentionAttachments;
    const { insertCitationAtSelection } = fileIntake;
    const { trackerSources } = referencePicker;
    const { setReferencePicker } = referencePickerState;
    const { isVSCode } = runtime;

    const guestAttachItems = useGuestAttachItems();

    const openGuestAttach = React.useCallback((guestId: string) => {
        const item = guestAttachItems.find((guest) => guest.id === guestId);
        if (item?.mode === 'dialog') {
            setAttachDialogItem(null);
            setAttachDialogGuestId(guestId);
            return;
        }
        if (isMobileSurfaceRuntime()) {
            openGuestSurface({ mode: pluginModeFromId(guestId), directory: currentDirectory || null, supported: true });
            return;
        }
        useUIStore.getState().openContextSurface(currentDirectory || '', pluginModeFromId(guestId));
    }, [currentDirectory, guestAttachItems, setAttachDialogItem, setAttachDialogGuestId]);

    const reopenGuestItem = React.useCallback((reference: Extract<ComposerReference, { kind: 'guest' }>) => {
        const issue: AttachIssueRequest = {
            providerId: reference.providerId,
            id: reference.id,
            title: reference.title,
            url: reference.url,
            text: reference.contextText,
            kind: reference.thread,
        };
        if (reference.author) issue.author = reference.author;
        if (reference.head && reference.base) {
            issue.branches = { head: reference.head, base: reference.base };
        }
        if (reference.data !== undefined) issue.data = reference.data;
        const installed = useGuestsStore.getState().guests.find((entry) => entry.id === issue.providerId);
        if (!installed || !isGuestActive(installed)) {
            const supported = useGuestsStore.getState().status !== 'unsupported';
            toast.info(t(!supported
                ? 'chat.chatInput.toast.guestUnavailableHere'
                : installed ? 'chat.chatInput.toast.guestOff' : 'chat.chatInput.toast.guestRemoved'));
            return;
        }
        if (!guestPanelOpensHere(installed)) {
            toast.info(t('chat.chatInput.toast.guestNotOnPhone', { name: installed.name }));
            return;
        }
        if (!installed.entry) {
            toast.info(t('chat.chatInput.toast.guestHasNoPanel'));
            return;
        }
        const guest = guestAttachItems.find((entry) => entry.id === issue.providerId);
        if (guest?.mode !== 'dialog') {
            if (!openGuestWithItem({ id: issue.providerId, attach: undefined }, issue, currentDirectory)) {
                toast.info(t('chat.guestLink.noProject', { name: installed.name }));
            }
            return;
        }
        setAttachDialogItem(issue);
        setAttachDialogGuestId(issue.providerId);
    }, [currentDirectory, guestAttachItems, t, setAttachDialogItem, setAttachDialogGuestId]);

    const openSharedPage = React.useMemo(() => {
        const reference = openSharedPageKey ? linkedReferences.find((entry) => composerReferenceKey(entry) === openSharedPageKey) : undefined;
        return reference?.kind === 'shared-page' ? reference : null;
    }, [linkedReferences, openSharedPageKey]);

    const openAttachmentTarget = useOpenAttachment(handleShowAttachmentPreview);

    chipOpenRef.current = (target: ComposerChipTarget) => {
        if (target.kind === 'link') {
            const reference = linkedReferences.find((entry) => referenceTextLink(entry) === target.url);
            if (reference?.kind === 'shared-page') {
                setOpenSharedPageKey(composerReferenceKey(reference));
                return;
            }
            if (reference?.kind === 'guest') {
                reopenGuestItem(reference);
                return;
            }
            openAttachmentTarget({ kind: 'external', url: target.url });
            return;
        }
        if (target.kind === 'path') {
            openAttachmentTarget({ kind: 'file', path: target.path });
            return;
        }
        const files = sanitizeAttachmentsForSend(attachedFiles).map((file) => ({ filename: file.filename, mime: file.mimeType, url: file.dataUrl }));
        const opened = resolveAttachmentOpenTarget(findAttachmentPart(target.filename, files), files);
        if (opened) openAttachmentTarget(opened);
    };

    const openAttachmentByName = React.useCallback((filename: string) => chipOpenRef.current({ kind: 'attachment', filename }), [chipOpenRef]);

    const seenReferencesRef = React.useRef<{ draftKey: string; items: Map<string, ComposerReference> } | null>(null);

    React.useEffect(() => {
        const draftKey = chatDraftIdentityKey ?? '';
        const items = new Map(linkedReferences.map((reference) => [composerReferenceKey(reference), reference]));
        const seen = seenReferencesRef.current;
        seenReferencesRef.current = { draftKey, items };
        if (!seen || seen.draftKey !== draftKey) return;
        const fresh = linkedReferences.filter((reference) => {
            const before = seen.items.get(composerReferenceKey(reference));
            return !before || (before !== reference && before.kind !== 'shared-page');
        });
        if (fresh.length === 0) return;
        const text = composerRef.current?.getValue() ?? composerText.get();
        const missing = fresh.filter((reference) => referencesLinkedIn(text, [reference]).length === 0);
        if (missing.length > 0) insertCitationAtSelection(missing.map(referenceTextLink).join(' '), '');
    }, [chatDraftIdentityKey, composerText, insertCitationAtSelection, linkedReferences, composerRef]);

    React.useEffect(() => {
        if (!pendingGuestIssue || columnPinned || isBtwActive) {
            return;
        }
        const issue = consumePendingGuestIssue();
        if (issue) {
            handleGuestAttach(issue);
        }
    }, [columnPinned, consumePendingGuestIssue, handleGuestAttach, isBtwActive, pendingGuestIssue]);

    const composerReferenceHandoffTarget = React.useMemo<ComposerReferenceHandoff | null>(() => (
        resolveComposerReferenceHandoffTarget({
            columnPinned,
            btwActive: isBtwActive,
            currentSessionId,
            draftOpen: newSessionDraftOpen,
            workDraftId: newSessionDraft?.workDraftId ?? null,
            runtimeKey: activeRuntimeKey,
        })
    ), [activeRuntimeKey, columnPinned, currentSessionId, isBtwActive, newSessionDraft?.workDraftId, newSessionDraftOpen]);

    React.useEffect(() => {
        if (pendingComposerReferenceCount === 0 || !composerReferenceHandoffTarget) return;
        const references = usePendingComposerReferences.getState().consume(composerReferenceHandoffTarget);
        if (references.length > 0) {
            updateLinkedReferences((current) => withComposerReferences(current, references));
        }
    }, [composerReferenceHandoffTarget, pendingComposerReferenceCount, updateLinkedReferences]);

    const trackerPickers = React.useMemo<readonly ComposerTrackerPicker[]>(() => (
        !isVSCode
            ? trackerSources.map((descriptor) => {
                const presentation = trackerPresentation(descriptor.id);
                return {
                    provider: descriptor.id,
                    icon: presentation.icon,
                    label: t('chat.chatInput.actions.linkTrackerItem', { provider: descriptor.name }),
                    open: () => setReferencePicker({ source: trackerReferenceSource(descriptor.id) }),
                };
            })
            : []
    ), [isVSCode, t, trackerSources, setReferencePicker]);

    return {
        openAttachmentByName, trackerPickers, guestAttachItems, openGuestAttach,
        openSharedPage,
    };
}
