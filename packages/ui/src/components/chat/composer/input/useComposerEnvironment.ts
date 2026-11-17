import React from 'react';
import { useUIStore } from '@/stores/useUIStore';
import { useInputStore } from '@/sync/input-store';
import { getUnsupportedAttachmentInputs, type AttachmentInputModality } from '@/sync/attachment-files';
import { getRuntimeKey, subscribeRuntimeEndpointWillChange } from '@/lib/runtime-switch';
import { getChatDraftIdentityKey } from '@/lib/chatDraftPersistence';
import { useReviewFlowStart } from '@/components/session/useReviewFlowStart';
import { useBtwStore } from '@/stores/useBtwStore';
import type { ToolPopupContent } from '../../message/types';
import { useChatColumnExpandedInput } from '../../chatColumnSession';
import { toast } from '@/components/ui';
import { useTabletLayout } from '@/lib/device';
import { useHardwareKeyboard } from '@/lib/hardwareKeyboard';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { useChatSearchDirectory } from '@/hooks/useChatSearchDirectory';
import { useGitStore } from '@/stores/useGitStore';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { usePermissionStore } from '@/stores/permissionStore';
import { sessionEvents } from '@/lib/sessionEvents';
import { getEffectiveShortcutCombo } from '@/lib/shortcuts';
import { normalizePath, toProjectRelativeMentionPath } from '../../composer/attachments/filePaths';
import type { useComposerSessionScope } from './useComposerSessionScope';
import type { useComposerInputState } from './useComposerInputState';
import type { useComposerSelection } from './useComposerSelection';

type Dependencies = Pick<ReturnType<typeof useComposerSessionScope>, 'activeRuntimeKey' | 'chatDraftIdentity' | 'inputMode' | 'isBtwActive' | 'currentSessionId' | 'attachedFiles' | 'currentDirectory' | 'closeReviewDialog'>
    & Pick<ReturnType<typeof useComposerInputState>, 'largeTextPasteGesture' | 'largeTextPasteOfferIdRef' | 'setLargeTextPasteOffer' | 'composerRef' | 't'>
    & Pick<ReturnType<typeof useComposerSelection>, 'currentProviderId' | 'currentModelId' | 'currentModelMetadata'>;

export function useComposerEnvironment({
    activeRuntimeKey, chatDraftIdentity, inputMode, largeTextPasteGesture, largeTextPasteOfferIdRef,
    setLargeTextPasteOffer, composerRef, isBtwActive, currentSessionId, currentProviderId, currentModelId,
    currentModelMetadata, attachedFiles, t, currentDirectory, closeReviewDialog,
}: Dependencies) {
    const isMobile = useUIStore((state) => state.isMobile);

    const hasHardwareKeyboard = useHardwareKeyboard();

    const enterToSend = useUIStore((state) => state.enterToSend);

    const enterToSendConfigured = useUIStore((state) => state.enterToSendConfigured);

    const mobileReturnKeySends = useUIStore((state) => state.mobileReturnKeySends);

    const { enabled: isTabletLayout, roomyForOnePanel } = useTabletLayout();

    const setImagePreviewOpen = useUIStore((state) => state.setImagePreviewOpen);

    const inputBarOffset = useUIStore((state) => state.inputBarOffset);

    const inputSpellcheckEnabled = useUIStore((state) => state.inputSpellcheckEnabled);

    const largeTextPasteBehavior = useUIStore((state) => state.largeTextPasteBehavior);

    const largeTextPasteScope = JSON.stringify([
        activeRuntimeKey, chatDraftIdentity ? getChatDraftIdentityKey(chatDraftIdentity) : null,
        inputMode, largeTextPasteBehavior,
    ]);

    const largeTextPasteScopeRef = React.useRef(largeTextPasteScope);

    React.useLayoutEffect(() => {
        largeTextPasteScopeRef.current = largeTextPasteScope;
        largeTextPasteGesture.invalidate();
        // An unanswered choice belongs to the draft it was pasted into; it
        // must not land in another one. The text is still on the clipboard.
        largeTextPasteOfferIdRef.current += 1;
        setLargeTextPasteOffer(null);
        return () => largeTextPasteGesture.invalidate();
    }, [largeTextPasteGesture, largeTextPasteScope, largeTextPasteOfferIdRef, setLargeTextPasteOffer]);

    React.useEffect(() => subscribeRuntimeEndpointWillChange(() => largeTextPasteGesture.invalidate()), [largeTextPasteGesture]);

    const getLargeTextPasteScope = React.useCallback(() => (
        JSON.stringify([getRuntimeKey(), largeTextPasteScopeRef.current, useInputStore.getState().attachmentDraftKey])
    ), []);

    const readLargeTextPasteSnapshot = React.useCallback(() => {
        const editor = composerRef.current;
        if (!editor) return null;
        return {
            value: editor.getValue(), selection: editor.getSelection(),
            scope: getLargeTextPasteScope(),
        };
    }, [getLargeTextPasteScope, composerRef]);

    const { expanded: persistedExpandedInput, setExpanded: setExpandedInput } = useChatColumnExpandedInput();

    const isExpandedInput = !isBtwActive && persistedExpandedInput;

    const { git: runtimeGit, vscode: vscodeApi, trackers: runtimeTrackers } = useRuntimeAPIs();

    const cycleAgentShortcutOverride = useUIStore((state) => state.shortcutOverrides.cycle_agent);

    const cycleAgentShortcut = React.useMemo(() => (
        getEffectiveShortcutCombo('cycle_agent', cycleAgentShortcutOverride ? { cycle_agent: cycleAgentShortcutOverride } : undefined)
    ), [cycleAgentShortcutOverride]);

    const { currentTheme } = useThemeSystem();

    const chatSearchDirectory = useChatSearchDirectory();

    const ensureGitStatus = useGitStore((state) => state.ensureStatus);

    const fetchGitStatus = useGitStore((state) => state.fetchStatus);

    const clearGitDiffCache = useGitStore((state) => state.clearDiffCache);

    const setSessionMode = usePermissionStore((state) => state.setSessionMode);

    const pendingBtwPermissionMode = useBtwStore(React.useCallback(
        (state) => currentSessionId ? state.byParent[currentSessionId]?.pendingPermissionMode : undefined,
        [currentSessionId],
    ));

    const [attachmentPreview, setAttachmentPreview] = React.useState<ToolPopupContent>({
        open: false,
        title: '',
        content: '',
    });

    // Mount the lazy preview dialog only after its first open; rendering it
    // closed would fetch the ToolOutputDialog chunk (with the @pierre/diffs
    // stack) on the draft screen before any preview is requested.
    const [attachmentPreviewMounted, setAttachmentPreviewMounted] = React.useState(false);

    React.useEffect(() => {
        if (attachmentPreview.open) {
            setAttachmentPreviewMounted(true);
        }
    }, [attachmentPreview.open]);

    const attachmentCompatibilityRef = React.useRef({
        modelKey: `${currentProviderId ?? ''}/${currentModelId ?? ''}`,
        modalitySignature: currentModelMetadata?.modalities?.input?.slice().sort().join(',') ?? null,
        attachmentIds: new Set<string>(),
    });

    React.useEffect(() => {
        const modelKey = `${currentProviderId ?? ''}/${currentModelId ?? ''}`;
        const inputModalities = currentModelMetadata?.modalities?.input;
        const modalitySignature = inputModalities?.slice().sort().join(',') ?? null;
        const previous = attachmentCompatibilityRef.current;
        const modelChanged = previous.modelKey !== modelKey;
        const metadataBecameAvailable = previous.modalitySignature === null && modalitySignature !== null;
        const filesToCheck = modelChanged || metadataBecameAvailable
            ? attachedFiles
            : attachedFiles.filter((file) => !previous.attachmentIds.has(file.id));

        attachmentCompatibilityRef.current = {
            modelKey,
            modalitySignature,
            attachmentIds: new Set(attachedFiles.map((file) => file.id)),
        };

        if (!inputModalities || filesToCheck.length === 0) return;

        const incompatibleFiles = getUnsupportedAttachmentInputs(filesToCheck, inputModalities);
        if (incompatibleFiles.length === 0) return;

        const unsupportedModalities = Array.from(new Set(incompatibleFiles.map(({ modality }) => modality)));
        const modalityLabels: Record<AttachmentInputModality, string> = {
            text: t('chat.modelControls.modality.text'),
            image: t('chat.modelControls.modality.image'),
            pdf: t('chat.modelControls.modality.pdf'),
            audio: t('chat.modelControls.modality.audio'),
            video: t('chat.modelControls.modality.video'),
        };
        const filenames = incompatibleFiles.map(({ attachment }) => attachment.filename);
        const fileSummary = filenames.length > 3
            ? `${filenames.slice(0, 3).join(', ')} (+${filenames.length - 3})`
            : filenames.join(', ');

        toast.warning(t('chat.chatInput.toast.unsupportedAttachmentModalities', {
            model: currentModelMetadata.name ?? currentModelId ?? '',
            modalities: unsupportedModalities.map((modality) => modalityLabels[modality]).join(', '),
            files: fileSummary,
        }), { id: `attachment-modalities:${modelKey}` });
    }, [attachedFiles, currentModelId, currentModelMetadata, currentProviderId, t]);

    // An image opens the image viewer, a text file (a pasted text, a JSON
    // file) the text dialog, as the same chip in a sent message does.
    const handleShowAttachmentPreview = React.useCallback((content: ToolPopupContent) => {
        setAttachmentPreview(content);
        setImagePreviewOpen(true);
    }, [setImagePreviewOpen]);

    const handleAttachmentPreviewOpenChange = React.useCallback((open: boolean) => {
        setAttachmentPreview((prev) => ({ ...prev, open }));
        setImagePreviewOpen(open);
    }, [setImagePreviewOpen]);

    React.useEffect(() => {
        if (!currentDirectory || !runtimeGit) return;
        void ensureGitStatus(currentDirectory, runtimeGit);
    }, [currentDirectory, runtimeGit, ensureGitStatus]);

    React.useEffect(() => {
        if (!currentDirectory || !runtimeGit) return;
        return sessionEvents.onGitRefreshHint((hint) => {
            if (normalizePath(hint.directory) !== normalizePath(currentDirectory)) return;
            if (hint.paths?.length) {
                clearGitDiffCache(currentDirectory, hint.paths);
            }
            void fetchGitStatus(currentDirectory, runtimeGit, { silent: true });
        });
    }, [clearGitDiffCache, currentDirectory, runtimeGit, fetchGitStatus]);

    const { submitting: reviewFlowSubmitting, start: handleStartReviewFlow } = useReviewFlowStart(currentSessionId, currentDirectory, closeReviewDialog);

    const isDesktopExpanded = isExpandedInput && !isMobile;

    // Mobile fullscreen composer (entered via the drag handle's swipe-up).
    const isMobileExpanded = isExpandedInput && isMobile;

    const isComposerExpanded = isDesktopExpanded || isMobileExpanded;

    // Rounder composer on mobile (touch UI reads better with a softer corner).
    const chatInputRadius = isMobile ? '1.25rem' : 'var(--radius-xl)';

    // Mention paths are shown relative to the project the chat searches.
    const toMentionPath = React.useCallback(
        (absolutePath: string) => toProjectRelativeMentionPath(absolutePath, chatSearchDirectory || ""),
        [chatSearchDirectory],
    );

    return {
        isMobile, largeTextPasteScopeRef, currentTheme, chatSearchDirectory, setExpandedInput,
        hasHardwareKeyboard, isTabletLayout, roomyForOnePanel, isExpandedInput, pendingBtwPermissionMode,
        runtimeTrackers, largeTextPasteBehavior, isDesktopExpanded, cycleAgentShortcut, enterToSend,
        enterToSendConfigured, mobileReturnKeySends, isComposerExpanded, getLargeTextPasteScope,
        readLargeTextPasteSnapshot, toMentionPath, vscodeApi, handleShowAttachmentPreview, isMobileExpanded,
        setSessionMode, inputBarOffset, chatInputRadius, inputSpellcheckEnabled, reviewFlowSubmitting,
        handleStartReviewFlow, attachmentPreviewMounted, attachmentPreview,
        handleAttachmentPreviewOpenChange,
    };
}
