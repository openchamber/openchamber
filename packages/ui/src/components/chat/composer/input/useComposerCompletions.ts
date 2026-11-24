import type { useI18n } from '@/lib/i18n';
import type { useComposerSessionScope } from './useComposerSessionScope';
import type { useComposerReferenceDrafts } from './useComposerReferenceDrafts';
import type { useComposerMentionPaths } from './useComposerMentionPaths';
import type { useComposerLanguage } from './useComposerLanguage';
import type { useComposerEditorState } from './useComposerEditorState';
import type { useComposerEditorActions } from './useComposerEditorActions';
import type { useComposerDraftText } from './useComposerDraftText';
import type { useComposerAutocompleteState } from './useComposerAutocompleteState';
import type { ComposerSendHandlers } from './composerSendHandlers';
import { resolveGuestMention, type GuestMention } from '@/lib/guests/mentions';
import type { CommandInfo } from '../../CommandAutocomplete';
import { withoutSnippetToken } from '@/lib/snippetNames';
import { toast } from '@/components/ui';
import { sessionLinkText, sessionReference } from '../../composer/sessionReferences';
import { type Session } from '@/lib/opencode/model';
import { confirmMention } from '../../composer/language/mentions';
import { lastPrefixSigilIndex } from '../../composer/language/prefixTokens';
import { useComposerTextValue } from '../../composer/state/composerText';
import { useStableHandler } from './useStableHandler';

type Dependencies = {
    editorState: Pick<ReturnType<typeof useComposerEditorState>, 'composerRef'>;
    autocompleteState: Pick<ReturnType<typeof useComposerAutocompleteState>, 'completingMentionRef' | 'closeAutocomplete' | 'openAutocomplete' | 'autocompleteQuery'>;
    draftText: Pick<ReturnType<typeof useComposerDraftText>, 'confirmedMentionsRef' | 'composerText' | 'setMessage' | 'currentChatDraftIdentityRef'>;
    i18n: Pick<ReturnType<typeof useI18n>, 't'>;
    mentionPaths: Pick<ReturnType<typeof useComposerMentionPaths>, 'toMentionPath'>;
    language: Pick<ReturnType<typeof useComposerLanguage>, 'rememberSessionMentions'>;
    editorActions: Pick<ReturnType<typeof useComposerEditorActions>, 'updateAutocompleteState'>;
    referenceDrafts: Pick<ReturnType<typeof useComposerReferenceDrafts>, 'handleGuestAttach'>;
    sessionScope: Pick<ReturnType<typeof useComposerSessionScope>, 'currentSessionId'>;
    sendHandlers: Pick<ComposerSendHandlers, 'handleSubmitRef'>;
};

export function useComposerCompletions({
    editorState, autocompleteState, draftText, i18n, mentionPaths, language, editorActions,
    referenceDrafts, sessionScope, sendHandlers,
}: Dependencies) {
    const { composerRef } = editorState;
    const { completingMentionRef, closeAutocomplete, openAutocomplete, autocompleteQuery } = autocompleteState;
    const { confirmedMentionsRef, composerText, setMessage, currentChatDraftIdentityRef } = draftText;
    const { t } = i18n;
    const { toMentionPath } = mentionPaths;
    const { rememberSessionMentions } = language;
    const { updateAutocompleteState } = editorActions;
    const { handleGuestAttach } = referenceDrafts;
    const { currentSessionId } = sessionScope;
    const { handleSubmitRef } = sendHandlers;

    const completeMentionSelection = useStableHandler((name: string) => {
        const editor = composerRef.current;
        if (!editor) return;
        const value = editor.getValue();
        const cursorPosition = editor.getSelection().start;
        const lastAtSymbol = value.substring(0, cursorPosition).lastIndexOf('@');
        const start = lastAtSymbol === -1 ? cursorPosition : lastAtSymbol;

        completingMentionRef.current = true;
        try {
            editor.replaceRange(start, cursorPosition, `@${name} `);
        } finally {
            completingMentionRef.current = false;
        }
        closeAutocomplete();
        editor.focus();
    });

    const handleAgentSelect = useStableHandler((name: string) => {
        confirmMention(name.toLowerCase(), confirmedMentionsRef.current);
        completeMentionSelection(name);
    });

    const handleFileSelect = useStableHandler((file: { name: string; path: string; relativePath?: string }) => {
        const mentionPath = (file.relativePath && file.relativePath.trim().length > 0)
            ? file.relativePath.trim()
            : (toMentionPath(file.path) || file.name);
        confirmMention(mentionPath, confirmedMentionsRef.current);
        completeMentionSelection(mentionPath);
    });

    const handleSessionSelect = useStableHandler((session: Session) => {
        const message = composerText.get();
        const cursorPosition = composerRef.current?.getSelection().start ?? message.length;
        const lastAtSymbol = message.substring(0, cursorPosition).lastIndexOf('@');
        const start = lastAtSymbol === -1 ? cursorPosition : lastAtSymbol;
        const inserted = `${sessionLinkText(session.id)} `;
        rememberSessionMentions([sessionReference(session)]);
        const newMessage = message.substring(0, start) + inserted + message.substring(cursorPosition);
        setMessage(newMessage);
        const nextCursor = start + inserted.length;
        requestAnimationFrame(() => {
            composerRef.current?.setSelection(nextCursor);
            updateAutocompleteState(newMessage, nextCursor);
        });
        closeAutocomplete();
        composerRef.current?.focus();
    });

    const handleExtensionMentionSelect = useStableHandler((mention: GuestMention) => {
        const editor = composerRef.current;
        if (editor) {
            const value = editor.getValue();
            const cursorPosition = editor.getSelection().start;
            const lastAtSymbol = value.substring(0, cursorPosition).lastIndexOf('@');
            if (lastAtSymbol !== -1) editor.replaceRange(lastAtSymbol, cursorPosition, '');
        }
        closeAutocomplete();
        editor?.focus();
        const pickedIn = JSON.stringify(currentChatDraftIdentityRef.current);
        void resolveGuestMention(mention).then((item) => {
            if (!item) {
                toast.error(t('chat.composer.extensionMention.failed', { title: mention.title, extension: mention.label }));
                return;
            }
            if (JSON.stringify(currentChatDraftIdentityRef.current) === pickedIn) handleGuestAttach(item);
        });
    });

    const handleSkillSelect = useStableHandler((skillName: string) => {
        const message = composerText.get();
        const textarea = composerRef.current;
        const cursorPosition = textarea?.getSelection().start ?? message.length;
        const textBeforeCursor = message.substring(0, cursorPosition);
        const skillSigilIndex = lastPrefixSigilIndex(textBeforeCursor, '$');

        if (skillSigilIndex !== -1) {
            const newMessage =
                message.substring(0, skillSigilIndex) +
                `$${skillName} ` +
                message.substring(cursorPosition);
            setMessage(newMessage);

            const nextCursor = skillSigilIndex + skillName.length + 2;
            requestAnimationFrame(() => {
                if (composerRef.current) {
                    composerRef.current.setSelection(nextCursor);
                }
                updateAutocompleteState(newMessage, nextCursor);
            });
        }

        closeAutocomplete();

        composerRef.current?.focus();
    });

    const handleSnippetSelect = useStableHandler((_snippet: unknown, trigger: string) => {
        const message = composerText.get();
        const textarea = composerRef.current;
        const cursorPosition = textarea?.getSelection().start ?? message.length;
        const textBeforeCursor = message.substring(0, cursorPosition);
        const lastHashSymbol = textBeforeCursor.lastIndexOf('#');
        const startIndex = lastHashSymbol !== -1 ? lastHashSymbol : cursorPosition;
        const newMessage = `${message.substring(0, startIndex)}#${trigger} ${message.substring(cursorPosition)}`;
        setMessage(newMessage);
        const nextCursor = startIndex + trigger.length + 2;
        requestAnimationFrame(() => {
            if (composerRef.current) {
                composerRef.current.setSelection(nextCursor);
            }
            updateAutocompleteState(newMessage, nextCursor);
        });
        closeAutocomplete();
        composerRef.current?.focus();
    });

    const snippetDraftText = useComposerTextValue(
        composerText,
        (text) => (openAutocomplete === 'snippet' ? withoutSnippetToken(text, autocompleteQuery) : undefined),
    );

    const handleSnippetDraftSaved = useStableHandler((typedName: string) => {
        setMessage(withoutSnippetToken(composerText.get(), typedName));
    });

    const handleEmojiSelect = useStableHandler((emoji: string) => {
        const message = composerText.get();
        const cursorPosition = composerRef.current?.getSelection().start ?? message.length;
        const startIndex = Math.max(0, cursorPosition - autocompleteQuery.length - 1);
        const inserted = `${emoji} `;
        const newMessage = `${message.substring(0, startIndex)}${inserted}${message.substring(cursorPosition)}`;
        setMessage(newMessage);
        const nextCursor = startIndex + inserted.length;
        requestAnimationFrame(() => {
            composerRef.current?.setSelection(nextCursor);
            updateAutocompleteState(newMessage, nextCursor);
        });
        closeAutocomplete();
        composerRef.current?.focus();
    });

    const handleCommandSelect = useStableHandler((command: CommandInfo) => {
        if (command.name === 'btw' && currentSessionId) {
            closeAutocomplete();
            void handleSubmitRef.current({ presetText: '/btw' });
            return;
        }
        const text = `/${command.name} `;
        const editor = composerRef.current;
        if (editor) editor.replaceRange(0, editor.getValue().length, text, text.length);
        else setMessage(text);

        closeAutocomplete();

        const refocus = () => {
            if (composerRef.current) {
                try {
                    composerRef.current.focus({ preventScroll: true });
                } catch {
                    composerRef.current.focus();
                }
                composerRef.current.setSelection(composerRef.current.getValue().length, composerRef.current.getValue().length);
            }
        };

        requestAnimationFrame(() => {
            refocus();
            requestAnimationFrame(refocus);
        });
        setTimeout(refocus, 60);
    });

    return {
        handleCommandSelect, handleSkillSelect, handleSnippetSelect, snippetDraftText,
        handleSnippetDraftSaved, handleFileSelect, handleAgentSelect, handleSessionSelect,
        handleExtensionMentionSelect, handleEmojiSelect,
    };
}
