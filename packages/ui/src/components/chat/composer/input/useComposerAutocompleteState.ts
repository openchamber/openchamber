import React from 'react';
import type { FileMentionHandle } from '../../FileMentionAutocomplete';
import type { CommandAutocompleteHandle } from '../../CommandAutocomplete';
import type { SkillAutocompleteHandle } from '../../SkillAutocomplete';
import type { SnippetAutocompleteHandle } from '../../SnippetAutocomplete';
import type { EmojiAutocompleteHandle } from '@/components/emoji/EmojiAutocomplete';
import { type AutocompleteKind } from '../../composer/language/triggers';
import { MentionCompletionState } from '../../composer/state/mentionCompletion';



export function useComposerAutocompleteState() {
    const [openAutocomplete, setOpenAutocomplete] = React.useState<AutocompleteKind | null>(null);

    const [autocompleteQuery, setAutocompleteQuery] = React.useState('');

    const closeAutocomplete = React.useCallback(() => setOpenAutocomplete(null), []);
    const [mentionCompletion] = React.useState(() => new MentionCompletionState());

    const completingMentionRef = React.useRef(false);
    const mentionRef = React.useRef<FileMentionHandle>(null);

    const commandRef = React.useRef<CommandAutocompleteHandle>(null);

    const skillRef = React.useRef<SkillAutocompleteHandle>(null);

    const snippetRef = React.useRef<SnippetAutocompleteHandle>(null);

    const emojiRef = React.useRef<EmojiAutocompleteHandle>(null);

    return {
    openAutocomplete, setOpenAutocomplete, autocompleteQuery, setAutocompleteQuery, closeAutocomplete,
    mentionCompletion, completingMentionRef, mentionRef, commandRef, skillRef, snippetRef, emojiRef,
    };
}
