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
import type { useComposerSelection } from './useComposerSelection';
import type { useComposerSessionScope } from './useComposerSessionScope';
import type { useComposerInputState } from './useComposerInputState';
import type { useComposerEnvironment } from './useComposerEnvironment';
import { useStableHandler } from './useStableHandler';

const EMPTY_COMPOSER_SKILLS: [] = [];

type Dependencies = Pick<ReturnType<typeof useComposerSelection>, 'agents'>
    & Pick<ReturnType<typeof useComposerSessionScope>, 'currentDirectory' | 'currentSessionId' | 'newSessionDraftOpen' | 'newSessionDraft' | 'attachedFiles' | 'chatDraftIdentity' | 'currentSessionDirectoryForSync' | 'inputMode'>
    & Pick<ReturnType<typeof useComposerInputState>, 'columnPinned' | 't' | 'composerText' | 'composerRef' | 'confirmedMentionsRef' | 'pendingPastedAttachmentFilenamesRef'>
    & Pick<ReturnType<typeof useComposerEnvironment>, 'isMobile' | 'largeTextPasteScopeRef' | 'currentTheme'>;

export function useComposerLanguage({
    agents, currentDirectory, columnPinned, currentSessionId, newSessionDraftOpen, newSessionDraft, isMobile,
    attachedFiles, chatDraftIdentity, t, composerText, largeTextPasteScopeRef, composerRef,
    currentSessionDirectoryForSync, confirmedMentionsRef, inputMode, pendingPastedAttachmentFilenamesRef,
    currentTheme,
}: Dependencies) {
    const knownAgentNames = React.useMemo(
        () => new Set(agents.map((agent) => agent.name.toLowerCase())),
        [agents]
    );

    const knownAgentNamesRef = React.useRef(knownAgentNames);

    knownAgentNamesRef.current = knownAgentNames;

    // Known slash-invocations (commands + built-ins) and `$` skills, used to
    // highlight matching tokens in the composer, the same way confirmed
    // @files are.
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

    // Extension slash commands. Built-ins and OpenCode commands are reserved:
    // an extension command with one of those names is ignored.
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

    // The names this draft has had attached, kept across a reload while its
    // files are not: a chip whose file is gone draws as unavailable.
    const chatDraftIdentityKey = chatDraftIdentity ? getChatDraftIdentityKey(chatDraftIdentity) : null;

    const chatDraftIdentityKeyRef = React.useRef(chatDraftIdentityKey);

    chatDraftIdentityKeyRef.current = chatDraftIdentityKey;

    React.useEffect(() => {
        if (chatDraftIdentity) rememberDraftAttachmentNames(chatDraftIdentity, attachmentFilenames);
        // The key stands for the identity, which is a new object every render.
        // oxlint-disable-next-line react-hooks/exhaustive-deps
    }, [attachmentFilenames, chatDraftIdentityKey]);

    const missingAttachmentNames = React.useMemo(() => {
        if (!chatDraftIdentity) return [];
        const present = new Set(attachmentFilenames.map((name) => name.toLowerCase()));
        return readDraftAttachmentNames(chatDraftIdentity).filter((name) => !present.has(name.toLowerCase()));
        // oxlint-disable-next-line react-hooks/exhaustive-deps
    }, [attachmentFilenames, chatDraftIdentityKey]);

    // Sessions and messages mentioned in the text, by `sessionLinkKey`. The
    // text decides what goes out: a mention deleted from it is not sent.
    const [sessionMentions, setSessionMentions] = React.useState<ReadonlyMap<string, SessionReference>>(() => new Map());

    const sessionMentionsRef = React.useRef(sessionMentions);

    React.useLayoutEffect(() => {
        sessionMentionsRef.current = sessionMentions;
    }, [sessionMentions]);

    // The ref moves at once, so a send right after a read sees what it found.
    const rememberSessionMentions = React.useCallback((references: readonly SessionReference[]) => {
        if (references.length === 0) return;
        const next = new Map(sessionMentionsRef.current);
        for (const reference of references) next.set(sessionReferenceKey(reference), reference);
        sessionMentionsRef.current = next;
        setSessionMentions(next);
    }, []);

    const sessionLinkOrigins = React.useMemo(() => appOwnOrigins(), []);

    // Links read once already, found or not: text typed or restored is read
    // quietly, and a link that failed is not read again on every keystroke.
    const attemptedSessionLinksRef = React.useRef(new Set<string>());

    // A mentioned session or message draws as a chip once read; one this
    // server cannot resolve stays a plain link. `announce` says so: a paste
    // and a send do, text typed or restored does not.
    const resolveSessionLinks = React.useCallback(async (targets: readonly SessionLinkTarget[], announce: boolean) => {
        const pending = targets.filter((target) => !sessionMentionsRef.current.has(sessionLinkKey(target)));
        if (pending.length === 0) return;
        for (const target of pending) attemptedSessionLinksRef.current.add(sessionLinkKey(target));
        const results = await Promise.allSettled(pending.map((target) => loadSessionLinkReference(target)));
        const resolved = results.flatMap((result) => (result.status === 'fulfilled' && result.value ? [result.value] : []));
        rememberSessionMentions(resolved);
        if (announce && resolved.length < pending.length) toast.error(t('chat.sessionReference.unavailable'));
    }, [rememberSessionMentions, t]);

    // Text that comes back without a paste (a revert, a fork, a restored
    // draft, a link typed by hand) gets its chips too.
    useComposerTextEffect(composerText, (message) => {
        if (isVSCodeRuntime()) return;
        const pending = findSessionLinks(message, sessionLinkOrigins)
            .map((range) => range.target)
            .filter((target) => !attemptedSessionLinksRef.current.has(sessionLinkKey(target)));
        if (pending.length > 0) void resolveSessionLinks(pending, false);
    }, [resolveSessionLinks, sessionLinkOrigins]);

    // Read before a send consumes anything: a second Enter while the read is
    // out does nothing, and a link the read cannot resolve goes as the text it is.
    const sessionMentionReadRef = React.useRef(false);

    // Pasted issue and PR links being read, by the link: a send waits for them too.
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

    // A pasted id becomes the link once its session is read. One this server
    // does not have stays the text it is, with nothing to announce.
    const linkPastedSessionId = useStableHandler(async (range: PastedSessionIdRange) => {
        // This composer's own draft: focus moving to another column must not
        // cancel the link, so the shared attachment slot stays out of it.
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

    // What the text mentions, once each, in order.
    const sessionMentionsIn = React.useCallback((text: string): SessionReference[] => (
        isVSCodeRuntime() ? [] : sessionReferencesInText(text, sessionLinkOrigins, sessionMentionsRef.current).references
    ), [sessionLinkOrigins]);

    const sessionLinkChips = React.useMemo(() => new Map([...sessionMentions].map(([key, reference]) => {
        const chip = sessionMentionChip(reference);
        return [key, { label: chip.label, title: chip.title, iconHref: `#oc-${chip.icon}` }] as const;
    })), [sessionMentions]);

    // Issues, change requests and tracker items linked in the text, by the
    // link as written. A pasted link is read like the picker's choice; the
    // text decides what is sent, as with session links.
    const referencePickerDirectory = currentSessionDirectoryForSync ?? currentDirectory ?? null;

    const repositoryUrls = useRepositoryUrlMatcher();

    const trackerUrls = useTrackerUrlMatcher();

    const readReferenceLink = useReadReferenceLink(referencePickerDirectory);

    const [referenceLinks, setReferenceLinks] = React.useState<ReadonlyMap<string, ComposerReference>>(() => new Map());

    const referenceLinksRef = React.useRef(referenceLinks);

    React.useLayoutEffect(() => {
        referenceLinksRef.current = referenceLinks;
    }, [referenceLinks]);

    // The ref moves at once, so a send right after a read sees what it found.
    const rememberReferenceLinks = React.useCallback((entries: ReadonlyArray<readonly [string, ComposerReference]>) => {
        if (entries.length === 0) return;
        const next = new Map(referenceLinksRef.current);
        for (const [link, reference] of entries) next.set(link, reference);
        referenceLinksRef.current = next;
        setReferenceLinks(next);
    }, []);

    // Each paste reads afresh, as the picker does. One that cannot be read
    // stays a plain link, and the toast says why.
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

    // The draft's items (picked, handed over, put back) draw as their links' chips too.
    const linkedReferences = useDraftLinkedReferences(chatDraftIdentity);

    // The shared page whose card is open: its PIN, its state, removing it.
    const [openSharedPageKey, setOpenSharedPageKey] = React.useState<string | null>(null);

    const referenceLinkChips = React.useMemo(() => new Map([
        ...[...referenceLinks].map(([link, reference]) => [link, referenceLinkChip(reference, repositoryUrls)] as const),
        ...linkedReferences.map((reference) => [referenceTextLink(reference), referenceLinkChip(reference, repositoryUrls)] as const),
    ]), [linkedReferences, referenceLinks, repositoryUrls]);

    /**
     * Everything the prompt language needs to resolve references. Rebuilt only
     * when a registry changes, so typing does not churn the tokenizer input.
     */
    const [confirmedMentionsRevision, setConfirmedMentionsRevision] = React.useState(0);

    const mentionDismissal = React.useMemo(() => ({
        dismiss: (name: string) => dismissMention(name, confirmedMentionsRef.current),
        hint: t('chat.chatInput.mentionChip.editHint'),
    }), [t, confirmedMentionsRef]);

    // The chip opener is set further down, once what it needs exists.
    const chipOpenRef = React.useRef<(target: ComposerChipTarget) => void>(() => {});

    const openChip = React.useCallback((target: ComposerChipTarget) => chipOpenRef.current(target), []);

    const languageContext = React.useMemo<ComposerLanguageContext>(() => ({
        inputMode,
        onChipOpen: openChip,
        knownAgentNames,
        // A getter: a draft switch puts a new set in the ref without a new context.
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
