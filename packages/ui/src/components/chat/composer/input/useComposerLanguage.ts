import type { useI18n } from '@/lib/i18n';
import type { useComposerSessionScope } from './useComposerSessionScope';
import type { useComposerSelection } from './useComposerSelection';
import type { useComposerPreferences } from './useComposerPreferences';
import type { useComposerLargePasteScope } from './useComposerLargePasteScope';
import type { useComposerEditorState } from './useComposerEditorState';
import type { useComposerDraftText } from './useComposerDraftText';
import type { useComposerColumn } from './useComposerColumn';
import type { useComposerAttachmentWork } from './useComposerAttachmentWork';
import React from 'react';
import { useSnippetsStore } from '@/stores/useSnippetsStore';
import { getChatDraftIdentityKey } from '@/lib/chatDraftPersistence';
import { toast } from '@/components/ui';
import { isVSCodeRuntime } from '@/lib/desktop';
import { useReadReferenceLink } from '@/components/references/useAttachReferences';
import { trackerItemLabel } from '@/components/sourceBoard/openTrackerItem';
import { useRepositoryUrlMatcher } from '@/lib/source-control/repositoryUrlMatcher';
import { useTrackerUrlMatcher } from '@/lib/trackers/matchTrackerUrl';
import { type ComposerReference } from '../../composer/composerReferences';
import { findReferenceLinks, findWebLinks, referenceLinkChip, referenceLinksInText, referenceTextLink } from '../../composer/referenceLinks';
import { loadSessionLinkReference, sessionReferenceKey, sessionReferencesInText, type SessionReference } from '../../composer/sessionReferences';
import { PastedSessionIds, sessionLinkOverPastedId, type PastedSessionIdRange } from '../../composer/pastedSessionIds';
import { findSessionLinks, sessionLinkKey, type SessionLinkTarget } from '@/lib/sessionLinks';
import { sessionMentionChip } from '@/lib/messages/sessionMentionChip';
import { appOwnOrigins } from '@/lib/router/appOrigins';
import { useDraftLinkedReferences } from '../../composer/linkedReferenceDrafts';
import { useGuestCommands } from '@/hooks/useGuestSurfaces';
import { reservedComposerCommandNames } from '../../composer/submit/guestCommands';
import { selectAvailableSkillsForDirectory, useSkillsStore } from '@/stores/useSkillsStore';
import { selectCommandsForComposer, useCommandsStore } from '@/stores/useCommandsStore';
import { useComposerConfigDirectory } from '@/hooks/useComposerConfigDirectory';
import { readDraftAttachmentNames, rememberDraftAttachmentNames } from '@/lib/draftAttachmentNames';
import { dismissMention } from '../../composer/language/mentions';
import { type ComposerChipTarget, type ComposerLanguageContext } from '../../composer/language/tokenize';
import { useComposerTextEffect } from '../../composer/state/composerText';
import { useStableHandler } from './useStableHandler';

const EMPTY_COMPOSER_SKILLS: [] = [];

type Dependencies = {
    selection: Pick<ReturnType<typeof useComposerSelection>, 'agents'>;
    sessionScope: Pick<ReturnType<typeof useComposerSessionScope>, 'currentDirectory' | 'currentSessionId' | 'newSessionDraftOpen' | 'newSessionDraft' | 'attachedFiles' | 'chatDraftIdentity' | 'currentSessionDirectoryForSync' | 'inputMode'>;
    column: Pick<ReturnType<typeof useComposerColumn>, 'columnPinned'>;
    i18n: Pick<ReturnType<typeof useI18n>, 't'>;
    draftText: Pick<ReturnType<typeof useComposerDraftText>, 'composerText' | 'confirmedMentionsRef'>;
    editorState: Pick<ReturnType<typeof useComposerEditorState>, 'composerRef'>;
    attachmentWork: Pick<ReturnType<typeof useComposerAttachmentWork>, 'pendingPastedAttachmentFilenamesRef'>;
    preferences: Pick<ReturnType<typeof useComposerPreferences>, 'isMobile' | 'currentTheme'>;
    largePasteScope: Pick<ReturnType<typeof useComposerLargePasteScope>, 'largeTextPasteScopeRef'>;
};

export function useComposerLanguage({
    selection, sessionScope, column, i18n, draftText, editorState, attachmentWork, preferences, largePasteScope,
}: Dependencies) {
    const { agents } = selection;
    const {
        currentDirectory, currentSessionId, newSessionDraftOpen, newSessionDraft, attachedFiles,
        chatDraftIdentity, currentSessionDirectoryForSync, inputMode,
    } = sessionScope;
    const { columnPinned } = column;
    const { t } = i18n;
    const { composerText, confirmedMentionsRef } = draftText;
    const { composerRef } = editorState;
    const { pendingPastedAttachmentFilenamesRef } = attachmentWork;
    const { isMobile, currentTheme } = preferences;
    const { largeTextPasteScopeRef } = largePasteScope;

    const knownAgentNames = React.useMemo(
        () => new Set(agents.map((agent) => agent.name.toLowerCase())),
        [agents]
    );

    const knownAgentNamesRef = React.useRef(knownAgentNames);

    knownAgentNamesRef.current = knownAgentNames;

    const commandsTarget = useComposerConfigDirectory(currentDirectory);

    const availableCommands = useCommandsStore((s) => selectCommandsForComposer(s, commandsTarget));

    const commandsDirectory = commandsTarget.status === 'resolved' ? commandsTarget.directory : null;

    const preloadDraftCatalogs = !columnPinned && !currentSessionId && newSessionDraftOpen
        && Boolean(newSessionDraft.worktreeStartDirectory);

    React.useEffect(() => {
        if (!preloadDraftCatalogs || !commandsDirectory) return;
        void useCommandsStore.getState().loadCommands(commandsDirectory);
        void useSkillsStore.getState().loadSkills(commandsDirectory);
    }, [commandsDirectory, preloadDraftCatalogs]);

    const availableSkills = useSkillsStore((s) => commandsTarget.status === 'pending'
        ? EMPTY_COMPOSER_SKILLS
        : selectAvailableSkillsForDirectory(s, commandsTarget.directory));

    const knownSlashNames = React.useMemo(() => {
        const names = reservedComposerCommandNames(availableCommands);
        if (isMobile || isVSCodeRuntime()) names.delete('handoff-review');
        return names;
    }, [availableCommands, isMobile]);

    const knownSkillNames = React.useMemo(
        () => new Set(availableSkills.map((skill) => skill.name.toLowerCase())),
        [availableSkills],
    );

    const guestCommands = useGuestCommands(knownSlashNames);

    const knownSlashNamesWithGuests = React.useMemo(() => {
        if (guestCommands.length === 0) return knownSlashNames;
        const names = new Set(knownSlashNames);
        for (const entry of guestCommands) names.add(entry.command.name);
        return names;
    }, [guestCommands, knownSlashNames]);

    const availableSnippets = useSnippetsStore((s) => s.snippets);

    const knownSnippetTriggers = React.useMemo(() => {
        const triggers = new Set<string>();
        for (const snippet of availableSnippets) {
            triggers.add(snippet.name.toLowerCase());
            for (const alias of snippet.aliases ?? []) triggers.add(alias.toLowerCase());
        }
        return triggers;
    }, [availableSnippets]);

    const attachmentFilenames = React.useMemo(
        () => attachedFiles.map((file) => file.filename),
        [attachedFiles],
    );

    const chatDraftIdentityKey = chatDraftIdentity ? getChatDraftIdentityKey(chatDraftIdentity) : null;

    const chatDraftIdentityKeyRef = React.useRef(chatDraftIdentityKey);

    chatDraftIdentityKeyRef.current = chatDraftIdentityKey;

    React.useEffect(() => {
        if (chatDraftIdentity) rememberDraftAttachmentNames(chatDraftIdentity, attachmentFilenames);
        // oxlint-disable-next-line react-hooks/exhaustive-deps
    }, [attachmentFilenames, chatDraftIdentityKey]);

    const missingAttachmentNames = React.useMemo(() => {
        if (!chatDraftIdentity) return [];
        const present = new Set(attachmentFilenames.map((name) => name.toLowerCase()));
        return readDraftAttachmentNames(chatDraftIdentity).filter((name) => !present.has(name.toLowerCase()));
        // oxlint-disable-next-line react-hooks/exhaustive-deps
    }, [attachmentFilenames, chatDraftIdentityKey]);

    const [sessionMentions, setSessionMentions] = React.useState<ReadonlyMap<string, SessionReference>>(() => new Map());

    const sessionMentionsRef = React.useRef(sessionMentions);

    React.useLayoutEffect(() => {
        sessionMentionsRef.current = sessionMentions;
    }, [sessionMentions]);

    const rememberSessionMentions = React.useCallback((references: readonly SessionReference[]) => {
        if (references.length === 0) return;
        const next = new Map(sessionMentionsRef.current);
        for (const reference of references) next.set(sessionReferenceKey(reference), reference);
        sessionMentionsRef.current = next;
        setSessionMentions(next);
    }, []);

    const sessionLinkOrigins = React.useMemo(() => appOwnOrigins(), []);

    const attemptedSessionLinksRef = React.useRef(new Set<string>());

    const resolveSessionLinks = React.useCallback(async (targets: readonly SessionLinkTarget[], announce: boolean) => {
        const pending = targets.filter((target) => !sessionMentionsRef.current.has(sessionLinkKey(target)));
        if (pending.length === 0) return;
        for (const target of pending) attemptedSessionLinksRef.current.add(sessionLinkKey(target));
        const results = await Promise.allSettled(pending.map((target) => loadSessionLinkReference(target)));
        const resolved = results.flatMap((result) => (result.status === 'fulfilled' && result.value ? [result.value] : []));
        rememberSessionMentions(resolved);
        if (announce && resolved.length < pending.length) toast.error(t('chat.sessionReference.unavailable'));
    }, [rememberSessionMentions, t]);

    useComposerTextEffect(composerText, (message) => {
        if (isVSCodeRuntime()) return;
        const pending = findSessionLinks(message, sessionLinkOrigins)
            .map((range) => range.target)
            .filter((target) => !attemptedSessionLinksRef.current.has(sessionLinkKey(target)));
        if (pending.length > 0) void resolveSessionLinks(pending, false);
    }, [resolveSessionLinks, sessionLinkOrigins]);

    const sessionMentionReadRef = React.useRef(false);

    const referenceLinkReadsRef = React.useRef(new Map<string, Promise<unknown>>());

    const readSessionMentionsBeforeSend = React.useCallback(async (text: string): Promise<boolean> => {
        if (isVSCodeRuntime()) return true;
        const pending = findSessionLinks(text, sessionLinkOrigins)
            .map((range) => range.target)
            .filter((target) => !sessionMentionsRef.current.has(sessionLinkKey(target)));
        const linkReads = findWebLinks(text).flatMap(({ link }) => referenceLinkReadsRef.current.get(link) ?? []);
        if (pending.length === 0 && linkReads.length === 0) return true;
        if (sessionMentionReadRef.current) return false;
        sessionMentionReadRef.current = true;
        try {
            await Promise.all([pending.length > 0 ? resolveSessionLinks(pending, true) : null, ...linkReads]);
        } finally {
            sessionMentionReadRef.current = false;
        }
        return true;
    }, [resolveSessionLinks, sessionLinkOrigins]);

    const [pastedSessionIds] = React.useState(() => new PastedSessionIds());

    const linkPastedSessionId = useStableHandler(async (range: PastedSessionIdRange) => {
        const scope = largeTextPasteScopeRef.current;
        const reference = await loadSessionLinkReference({ sessionId: range.sessionId, messageId: null }).catch(() => null);
        const followed = pastedSessionIds.settle(range);
        const editor = composerRef.current;
        if (!reference || !followed || !editor || scope !== largeTextPasteScopeRef.current) return;
        const replacement = sessionLinkOverPastedId(editor.getValue(), range, editor.getSelection(), sessionLinkOrigins);
        if (!replacement) return;
        rememberSessionMentions([reference]);
        editor.replaceRange(range.from, range.to, replacement.link, replacement.selection.start, replacement.selection.end);
    });

    const sessionMentionsIn = React.useCallback((text: string): SessionReference[] => (
        isVSCodeRuntime() ? [] : sessionReferencesInText(text, sessionLinkOrigins, sessionMentionsRef.current).references
    ), [sessionLinkOrigins]);

    const sessionLinkChips = React.useMemo(() => new Map([...sessionMentions].map(([key, reference]) => {
        const chip = sessionMentionChip(reference);
        return [key, { label: chip.label, title: chip.title, iconHref: `#oc-${chip.icon}` }] as const;
    })), [sessionMentions]);

    const referencePickerDirectory = currentSessionDirectoryForSync ?? currentDirectory ?? null;

    const repositoryUrls = useRepositoryUrlMatcher();

    const trackerUrls = useTrackerUrlMatcher();

    const readReferenceLink = useReadReferenceLink(referencePickerDirectory);

    const [referenceLinks, setReferenceLinks] = React.useState<ReadonlyMap<string, ComposerReference>>(() => new Map());

    const referenceLinksRef = React.useRef(referenceLinks);

    React.useLayoutEffect(() => {
        referenceLinksRef.current = referenceLinks;
    }, [referenceLinks]);

    const rememberReferenceLinks = React.useCallback((entries: ReadonlyArray<readonly [string, ComposerReference]>) => {
        if (entries.length === 0) return;
        const next = new Map(referenceLinksRef.current);
        for (const [link, reference] of entries) next.set(link, reference);
        referenceLinksRef.current = next;
        setReferenceLinks(next);
    }, []);

    const readPastedReferenceLinks = useStableHandler(async (text: string) => {
        const pending = findReferenceLinks(text, repositoryUrls, trackerUrls);
        if (pending.length === 0) return;
        const reads = referenceLinkReadsRef.current;
        const read = Promise.allSettled(pending.map(({ target }) => readReferenceLink(target)));
        for (const { link } of pending) reads.set(link, read);
        const results = await read;
        for (const { link } of pending) if (reads.get(link) === read) reads.delete(link);
        rememberReferenceLinks(results.flatMap((result, index) => (
            result.status === 'fulfilled' ? [[pending[index].link, result.value] as const] : []
        )));
        const failed = results.flatMap((result, index) => (result.status === 'rejected' ? [{ index, reason: result.reason }] : []));
        if (failed.length > 0) {
            toast.error(t('references.picker.error.attachFailed', {
                items: failed.map(({ index }) => trackerItemLabel(pending[index].link, repositoryUrls, trackerUrls) ?? pending[index].link).join(', '),
                error: failed[0].reason instanceof Error ? failed[0].reason.message : String(failed[0].reason),
            }));
        }
    });

    const referenceLinksIn = React.useCallback((text: string): ComposerReference[] => (
        isVSCodeRuntime() ? [] : referenceLinksInText(text, referenceLinksRef.current)
    ), []);

    const linkedReferences = useDraftLinkedReferences(chatDraftIdentity);

    const [openSharedPageKey, setOpenSharedPageKey] = React.useState<string | null>(null);

    const referenceLinkChips = React.useMemo(() => new Map([
        ...[...referenceLinks].map(([link, reference]) => [link, referenceLinkChip(reference, repositoryUrls)] as const),
        ...linkedReferences.map((reference) => [referenceTextLink(reference), referenceLinkChip(reference, repositoryUrls)] as const),
    ]), [linkedReferences, referenceLinks, repositoryUrls]);

    const [confirmedMentionsRevision, setConfirmedMentionsRevision] = React.useState(0);

    const mentionDismissal = React.useMemo(() => ({
        dismiss: (name: string) => dismissMention(name, confirmedMentionsRef.current),
        hint: t('chat.chatInput.mentionChip.editHint'),
    }), [t, confirmedMentionsRef]);

    const chipOpenRef = React.useRef<(target: ComposerChipTarget) => void>(() => {});

    const openChip = React.useCallback((target: ComposerChipTarget) => chipOpenRef.current(target), []);

    const languageContext = React.useMemo<ComposerLanguageContext>(() => ({
        inputMode,
        onChipOpen: openChip,
        knownAgentNames,
        get confirmedMentions() { return confirmedMentionsRef.current; },
        confirmedMentionsRevision,
        mentionDismissal,
        knownSlashNames: knownSlashNamesWithGuests,
        knownSnippetTriggers,
        attachmentFilenames,
        pendingAttachmentFilenames: pendingPastedAttachmentFilenamesRef.current,
        missingAttachments: missingAttachmentNames.length > 0
            ? { names: missingAttachmentNames, title: t('chat.chatInput.attachment.unavailable') }
            : undefined,
        knownSkillNames,
        fileIconVariant: currentTheme.metadata.variant === 'light' ? 'light' : 'dark',
        sessionLinkChips,
        sessionLinkOrigins,
        referenceLinkChips,
    }), [attachmentFilenames, confirmedMentionsRevision, currentTheme.metadata.variant, inputMode, knownAgentNames, knownSkillNames, knownSlashNamesWithGuests, knownSnippetTriggers, mentionDismissal, missingAttachmentNames, openChip, referenceLinkChips, sessionLinkChips, sessionLinkOrigins, t, confirmedMentionsRef, pendingPastedAttachmentFilenamesRef]);

    return {
        knownAgentNamesRef, setConfirmedMentionsRevision, guestCommands, readSessionMentionsBeforeSend,
        linkedReferences, availableSkills, referenceLinksIn, sessionMentionsIn, rememberSessionMentions,
        referencePickerDirectory, chatDraftIdentityKeyRef, pastedSessionIds, linkPastedSessionId,
        setOpenSharedPageKey, sessionLinkOrigins, resolveSessionLinks, readPastedReferenceLinks,
        openSharedPageKey, chipOpenRef, chatDraftIdentityKey, attachmentFilenames, languageContext,
    };
}
