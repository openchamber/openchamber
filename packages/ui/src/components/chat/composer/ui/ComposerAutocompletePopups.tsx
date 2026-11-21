
import React from 'react';
import { AnimatePresence } from 'motion/react';

import { EmojiAutocomplete, type EmojiAutocompleteHandle } from '@/components/emoji/EmojiAutocomplete';
import { CommandAutocomplete, type CommandAutocompleteHandle, type CommandInfo } from '../../CommandAutocomplete';
import { FileMentionAutocomplete, type FileMentionHandle } from '../../FileMentionAutocomplete';
import type { GuestMention } from '@/lib/guests/mentions';
import { SkillAutocomplete, type SkillAutocompleteHandle } from '../../SkillAutocomplete';
import { SnippetAutocomplete, type SnippetAutocompleteHandle } from '../../SnippetAutocomplete';
import type { Session } from '@/lib/opencode/model';
import type { AutocompleteKind } from '../language/triggers';
import { GlassPopupMotion } from './GlassPopupMotion';

export interface AutocompleteOverlayPosition {
    top: number;
    left: number;
    width: number;
    place: 'above' | 'below';
    maxHeight: number;
}

function caretStyle(position: AutocompleteOverlayPosition | null): React.CSSProperties | undefined {
    if (!position) return undefined;
    return {
        left: `${position.left}px`,
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
    open: AutocompleteKind | null;
    query: string;
    overlayPosition: AutocompleteOverlayPosition | null;
    commandRef: React.RefObject<CommandAutocompleteHandle | null>;
    skillRef: React.RefObject<SkillAutocompleteHandle | null>;
    snippetRef: React.RefObject<SnippetAutocompleteHandle | null>;
    mentionRef: React.RefObject<FileMentionHandle | null>;
    emojiRef: React.RefObject<EmojiAutocompleteHandle | null>;
    onCommandSelect: (command: CommandInfo) => void;
    onSkillSelect: (skillName: string) => void;
    onSnippetSelect: (snippet: unknown, trigger: string) => void;
    snippetDraftText?: string;
    onSnippetDraftSaved?: (name: string) => void;
    onFileSelect: (file: { name: string; path: string; relativePath?: string }) => void;
    onAgentSelect: (agentName: string) => void;
    onSessionSelect?: (session: Session) => void;
    onExtensionMentionSelect?: (mention: GuestMention) => void;
    currentSessionId: string | null;
    onEmojiSelect: (emoji: string) => void;
    onClose: () => void;
}

function ComposerAutocompletePopupsView(props: ComposerAutocompletePopupsProps) {
    const { open } = props;
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
                    onExtensionMentionSelect={props.onExtensionMentionSelect}
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

export const ComposerAutocompletePopups = React.memo(ComposerAutocompletePopupsView);
