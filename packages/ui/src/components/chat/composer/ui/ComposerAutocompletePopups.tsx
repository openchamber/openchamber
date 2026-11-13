/**
 * The composer's autocomplete popups.
 *
 * Five pickers, one at a time: the command palette, the inline skill picker,
 * the snippet picker, the file/agent mention picker and the emoji picker. Which one is open is
 * decided by the prompt language, not here.
 *
 * A picker sits at the caret, right above the line being typed
 * (`useAutocompletePosition`, which `overlayPosition` carries), as every text
 * field's suggestions do; until the first measurement it anchors itself to
 * the composer's edge, which its own styles handle.
 */

import React from 'react';
import { AnimatePresence } from 'motion/react';

import { EmojiAutocomplete, type EmojiAutocompleteHandle } from '@/components/emoji/EmojiAutocomplete';
import { CommandAutocomplete, type CommandAutocompleteHandle, type CommandInfo } from '../../CommandAutocomplete';
import { FileMentionAutocomplete, type FileMentionHandle } from '../../FileMentionAutocomplete';
import { SkillAutocomplete, type SkillAutocompleteHandle } from '../../SkillAutocomplete';
import { SnippetAutocomplete, type SnippetAutocompleteHandle } from '../../SnippetAutocomplete';
import type { Session } from '@/lib/opencode/model';
import type { AutocompleteKind } from '../language/triggers';
import { GlassPopupMotion } from './GlassPopupMotion';

/** A caret placement relative to the composer box; with `place: 'above'`, `top` is the popup's bottom edge. */
export interface AutocompleteOverlayPosition {
    top: number;
    left: number;
    width: number;
    place: 'above' | 'below';
    maxHeight: number;
}

/** Caret placement, or undefined before it is measured, to let the picker anchor to the composer. */
function caretStyle(position: AutocompleteOverlayPosition | null): React.CSSProperties | undefined {
    if (!position) return undefined;
    return {
        left: `${position.left}px`,
        // The pickers carry `inset-s-0`, which right to left is `right: 0` and would win over `left`.
        right: 'auto',
        top: `${position.top}px`,
        bottom: 'auto',
        width: `${position.width}px`,
        maxWidth: `${position.width}px`,
        maxHeight: `${position.maxHeight}px`,
        marginBottom: 0,
        transform: position.place === 'above' ? 'translateY(-100%)' : undefined,
    };
}

interface ComposerAutocompletePopupsProps {
    /** Which picker is open, if any. */
    open: AutocompleteKind | null;
    query: string;
    /** Caret placement in focus mode; null when the picker anchors itself. */
    overlayPosition: AutocompleteOverlayPosition | null;
    commandRef: React.RefObject<CommandAutocompleteHandle | null>;
    skillRef: React.RefObject<SkillAutocompleteHandle | null>;
    snippetRef: React.RefObject<SnippetAutocompleteHandle | null>;
    mentionRef: React.RefObject<FileMentionHandle | null>;
    emojiRef: React.RefObject<EmojiAutocompleteHandle | null>;
    onCommandSelect: (command: CommandInfo) => void;
    onSkillSelect: (skillName: string) => void;
    onSnippetSelect: (snippet: unknown, trigger: string) => void;
    /** The draft without the `#name` being typed, offered to save as that snippet. */
    snippetDraftText?: string;
    onSnippetDraftSaved?: (name: string) => void;
    onFileSelect: (file: { name: string; path: string; relativePath?: string }) => void;
    onAgentSelect: (agentName: string) => void;
    /** Mentions another session; absent where the composer cannot attach one. */
    onSessionSelect?: (session: Session) => void;
    /** The session this composer writes to, which `@` never offers. */
    currentSessionId: string | null;
    onEmojiSelect: (emoji: string) => void;
    onClose: () => void;
}

function ComposerAutocompletePopupsView(props: ComposerAutocompletePopupsProps) {
    const { open } = props;
    // The wrapper is a zero-height box over the anchor's top edge, so the
    // picker's `bottom-full` and caret offsets resolve exactly as they would
    // against the anchor itself.
    return (
        <AnimatePresence>
            {open ? (
                <GlassPopupMotion key={open} pace="brief" className="absolute inset-x-0 top-0 z-[100] h-0 origin-top-left rtl:origin-top-right">
                    <AutocompletePopup {...props} open={open} />
                </GlassPopupMotion>
            ) : null}
        </AnimatePresence>
    );
}

function AutocompletePopup(props: ComposerAutocompletePopupsProps & { open: AutocompleteKind }) {
    const { open, query, overlayPosition, onClose } = props;

    const style = caretStyle(overlayPosition);

    switch (open) {
        case 'command':
            return (
                <CommandAutocomplete
                    ref={props.commandRef}
                    searchQuery={query}
                    onCommandSelect={props.onCommandSelect}
                    onClose={onClose}
                    style={style}
                />
            );
        case 'skill':
            return (
                <SkillAutocomplete
                    ref={props.skillRef}
                    searchQuery={query}
                    onSkillSelect={props.onSkillSelect}
                    onClose={onClose}
                    style={style}
                />
            );
        case 'snippet':
            return (
                <SnippetAutocomplete
                    ref={props.snippetRef}
                    searchQuery={query}
                    onSnippetSelect={props.onSnippetSelect}
                    draftText={props.snippetDraftText}
                    onDraftSaved={props.onSnippetDraftSaved}
                    onClose={onClose}
                    style={style}
                />
            );
        case 'mention':
            return (
                <FileMentionAutocomplete
                    ref={props.mentionRef}
                    searchQuery={query}
                    onFileSelect={props.onFileSelect}
                    onAgentSelect={props.onAgentSelect}
                    onSessionSelect={props.onSessionSelect}
                    currentSessionId={props.currentSessionId}
                    onClose={onClose}
                    style={style}
                />
            );
        case 'emoji':
            return (
                <EmojiAutocomplete
                    ref={props.emojiRef}
                    searchQuery={query}
                    onEmojiSelect={props.onEmojiSelect}
                    onClose={onClose}
                    style={style}
                />
            );
    }
}

/** Memoized: the composer re-renders on every keystroke, and nothing here depends on the draft text. */
export const ComposerAutocompletePopups = React.memo(ComposerAutocompletePopupsView);
