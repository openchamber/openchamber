
import {
    getFileMentionAutocompleteQuery,
    type FileMentionAutocompleteInputSource,
} from '../../fileMentionAutocompleteState';
import { matchEmojiTrigger } from '@/lib/emoji/shortcodes';
import { lastPrefixSigilIndex, type TokenPrefix } from './prefixTokens';

export type AutocompleteKind = 'command' | 'skill' | 'snippet' | 'mention' | 'emoji';

export interface AutocompleteTrigger {
    kind: AutocompleteKind;
    query: string;
}

export interface TriggerContext {
    inputMode: 'normal' | 'shell';
    mentionsEnabled?: boolean;
    inputSource?: FileMentionAutocompleteInputSource;
    insertedText?: string;
    mentionContinuesPastSpace?: (query: string) => boolean;
    mentionIsCompleted?: (start: number) => boolean;
}

const isWordBoundaryBefore = (text: string, index: number): boolean =>
    index <= 0 || /\s/.test(text[index - 1]);

function matchCommandPalette(value: string, cursorPosition: number): AutocompleteTrigger | null {
    if (!value.startsWith('/')) return null;

    const firstSpace = value.indexOf(' ');
    if (firstSpace !== -1) return null;

    const firstNewline = value.indexOf('\n');
    const commandEnd = firstNewline === -1 ? value.length : firstNewline;
    if (cursorPosition > commandEnd) return null;

    return { kind: 'command', query: value.substring(1, commandEnd) };
}

function matchInlineToken(
    value: string,
    cursorPosition: number,
    prefix: TokenPrefix,
    kind: AutocompleteKind,
): AutocompleteTrigger | null {
    const textBeforeCursor = value.substring(0, cursorPosition);
    const sigilIndex = lastPrefixSigilIndex(textBeforeCursor, prefix);
    if (sigilIndex === -1) return null;
    if (!isWordBoundaryBefore(textBeforeCursor, sigilIndex)) return null;

    const query = textBeforeCursor.substring(sigilIndex + 1);
    if (query.includes(' ') || query.includes('\n')) return null;

    return { kind, query };
}

export function matchSnippetTrigger(value: string, cursorPosition: number): string | null {
    return matchInlineToken(value, cursorPosition, '#', 'snippet')?.query ?? null;
}

export function resolveAutocompleteTrigger(
    value: string,
    cursorPosition: number,
    context: TriggerContext,
): AutocompleteTrigger | null {
    if (context.inputMode === 'shell') return null;

    return matchCommandPalette(value, cursorPosition)
        ?? matchInlineToken(value, cursorPosition, '$', 'skill')
        ?? matchInlineToken(value, cursorPosition, '#', 'snippet')
        ?? matchMention(value, cursorPosition, context)
        ?? matchEmoji(value, cursorPosition, context);
}

function matchEmoji(value: string, cursorPosition: number, context: TriggerContext): AutocompleteTrigger | null {
    if (context.inputSource === 'paste') return null;
    const query = matchEmojiTrigger(value, cursorPosition);
    return query === null ? null : { kind: 'emoji', query };
}

function matchMention(
    value: string,
    cursorPosition: number,
    context: TriggerContext,
): AutocompleteTrigger | null {
    if (context.mentionsEnabled === false) return null;
    const query = getFileMentionAutocompleteQuery({
        value,
        cursorPosition,
        inputSource: context.inputSource,
        insertedText: context.insertedText,
        continuesPastSpace: context.mentionContinuesPastSpace,
        isCompleted: context.mentionIsCompleted,
    });
    return query === null ? null : { kind: 'mention', query };
}
