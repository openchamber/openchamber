import React from 'react';
import { useUIStore } from '@/stores/useUIStore';
import type { AttachIssueRequest } from '@openchamber/sdk';
import { toast } from '@/components/ui';
import { isVSCodeRuntime } from '@/lib/desktop';
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
import type { useComposerReferenceDrafts } from './useComposerReferenceDrafts';
import type { useComposerSessionScope } from './useComposerSessionScope';
import type { useComposerInputState } from './useComposerInputState';
import type { useComposerLanguage } from './useComposerLanguage';
import type { useComposerEnvironment } from './useComposerEnvironment';
import type { useComposerMentionAttachments } from './useComposerMentionAttachments';
import type { useComposerFileIntake } from './useComposerFileIntake';
import type { useComposerReferencePicker } from './useComposerReferencePicker';
import type { useComposerMobileShell } from './useComposerMobileShell';

type Dependencies = Pick<ReturnType<typeof useComposerReferenceDrafts>, 'setAttachDialogItem' | 'setAttachDialogGuestId' | 'handleGuestAttach' | 'updateLinkedReferences'>
    & Pick<ReturnType<typeof useComposerSessionScope>, 'currentDirectory' | 'attachedFiles' | 'pendingGuestIssue' | 'isBtwActive' | 'consumePendingGuestIssue' | 'currentSessionId' | 'newSessionDraftOpen' | 'newSessionDraft' | 'activeRuntimeKey' | 'pendingComposerReferenceCount'>
    & Pick<ReturnType<typeof useComposerInputState>, 't' | 'composerRef' | 'composerText' | 'columnPinned'>
    & Pick<ReturnType<typeof useComposerLanguage>, 'openSharedPageKey' | 'linkedReferences' | 'chipOpenRef' | 'setOpenSharedPageKey' | 'chatDraftIdentityKey'>
    & Pick<ReturnType<typeof useComposerEnvironment>, 'handleShowAttachmentPreview'>
    & Pick<ReturnType<typeof useComposerMentionAttachments>, 'sanitizeAttachmentsForSend'>
    & Pick<ReturnType<typeof useComposerFileIntake>, 'insertCitationAtSelection'>
    & Pick<ReturnType<typeof useComposerReferencePicker>, 'trackerSources'>
    & Pick<ReturnType<typeof useComposerMobileShell>, 'setReferencePicker'>;

export function useComposerReferenceActions({
    setAttachDialogItem, setAttachDialogGuestId, currentDirectory, t, openSharedPageKey, linkedReferences,
    handleShowAttachmentPreview, chipOpenRef, setOpenSharedPageKey, sanitizeAttachmentsForSend,
    attachedFiles, chatDraftIdentityKey, composerRef, composerText, insertCitationAtSelection,
    pendingGuestIssue, columnPinned, isBtwActive, consumePendingGuestIssue, handleGuestAttach,
    currentSessionId, newSessionDraftOpen, newSessionDraft, activeRuntimeKey, pendingComposerReferenceCount,
    updateLinkedReferences, trackerSources, setReferencePicker,
}: Dependencies) {
    const footerGapClass = 'gap-x-1.5 gap-y-0';

    const isVSCode = isVSCodeRuntime();

    const guestAttachItems = useGuestAttachItems();

    const openGuestAttach = React.useCallback((guestId: string) => {
        const item = guestAttachItems.find((guest) => guest.id === guestId);
        if (item?.mode === 'dialog') {
            setAttachDialogItem(null);
            setAttachDialogGuestId(guestId);
            return;
        }
        // The phone's panel is the extension's workspace tab.
        if (isMobileSurfaceRuntime()) {
            openGuestSurface({ mode: pluginModeFromId(guestId), directory: currentDirectory || null, supported: true });
            return;
        }
        useUIStore.getState().openContextSurface(currentDirectory || '', pluginModeFromId(guestId));
    }, [currentDirectory, guestAttachItems, setAttachDialogItem, setAttachDialogGuestId]);

    // Clicking the guest chip reopens that guest with the chip as `ready.item`,
    // so it can show the item's details instead of its whole list. A panel
    // guest gets it through the rail hand-off store; a dialog guest as a prop.
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
        // A chip can outlive the place it was attached in: the session may be
        // open in VS Code, where extensions never load, or the extension may
        // be paused or removed here. Say so instead of opening
        // an empty surface.
        const installed = useGuestsStore.getState().guests.find((entry) => entry.id === issue.providerId);
        if (!installed || !isGuestActive(installed)) {
            const supported = useGuestsStore.getState().status !== 'unsupported';
            toast.info(t(!supported
                ? 'chat.chatInput.toast.guestUnavailableHere'
                : installed ? 'chat.chatInput.toast.guestOff' : 'chat.chatInput.toast.guestRemoved'));
            return;
        }
        // The phone opens an extension's panel or dialog only when it opted into the phone.
        if (!guestPanelOpensHere(installed)) {
            toast.info(t('chat.chatInput.toast.guestNotOnPhone', { name: installed.name }));
            return;
        }
        if (!installed.entry) {
            toast.info(t('chat.chatInput.toast.guestHasNoPanel'));
            return;
        }
        const guest = guestAttachItems.find((entry) => entry.id === issue.providerId);
        // Only an extension that declared a dialog gets one; everything else
        // (panel mode, no attach declared) opens the rail with the item.
        // The panel opens and stays open; a second chip click on an open panel
        // must not toggle it closed with the item still parked.
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

    // A click on a chip opens what it stands for, as the same chip in a sent
    // message does: an image or a text file in the viewer, a file attached by
    // path in the file viewer, an issue, change request or tracker item in the
    // Tracker. An extension's item goes back to its extension, a shared page
    // opens its card.
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

    // Items attached outside a paste (the pickers, an extension, a handed-over
    // or restored item, a shared page) stand in the text as their link's chip:
    // a new item whose link the text does not hold yet gets it at the caret.
    // An item the text no longer links stays behind and is not sent. The items
    // a draft already had when it came on screen are its own.
    const seenReferencesRef = React.useRef<{ draftKey: string; items: Map<string, ComposerReference> } | null>(null);

    React.useEffect(() => {
        const draftKey = chatDraftIdentityKey ?? '';
        const items = new Map(linkedReferences.map((reference) => [composerReferenceKey(reference), reference]));
        const seen = seenReferencesRef.current;
        seenReferencesRef.current = { draftKey, items };
        if (!seen || seen.draftKey !== draftKey) return;
        // A new item, or one picked again (a new object under the same key).
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

    // Only signed-in trackers are offered; connecting one happens in Settings.
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
        isVSCode, openAttachmentByName, trackerPickers, footerGapClass, guestAttachItems, openGuestAttach,
        openSharedPage,
    };
}
