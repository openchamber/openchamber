/**
 * The composer's autocomplete popups.
 *
 * Four pickers, one at a time: the command palette, the inline skill picker,
 * the snippet picker and the file/agent mention picker. Which one is open is
 * decided by the prompt language, not here.
 *
 * They are positioned differently depending on the composer's shape. In the
 * normal composer each picker anchors itself to the composer edge, which its
 * own styles handle. In desktop focus mode the composer fills the surface, so
 * a picker pinned to its edge would sit far from the text — there they are
 * placed at the caret instead, which is what `overlayPosition` carries.
 */

import React from 'react';
import { AnimatePresence } from 'motion/react';

import { CommandAutocomplete, type CommandAutocompleteHandle, type CommandInfo } from '../../CommandAutocomplete';
import { FileMentionAutocomplete, type FileMentionHandle } from '../../FileMentionAutocomplete';
import { SkillAutocomplete, type SkillAutocompleteHandle } from '../../SkillAutocomplete';
import { SnippetAutocomplete, type SnippetAutocompleteHandle } from '../../SnippetAutocomplete';
import type { AutocompleteKind } from '../language/triggers';
import { GlassPopupMotion } from './GlassPopupMotion';

export interface AutocompleteOverlayPosition {
    top: number;
    left: number;
    place: 'above' | 'below';
    maxHeight: number;
}

/** Widths each picker asks for when placed at the caret. */
const CARET_PLACED_WIDTH: Record<AutocompleteKind, number> = {
    mention: 520,
    command: 450,
    snippet: 450,
    skill: 360,
};

/**
 * Caret placement, or undefined to let the picker anchor to the composer.
 * Only focus mode uses the caret; everywhere else the composer is short
 * enough that its edge is close to the text.
 */
function caretStyle(
    kind: AutocompleteKind,
    position: AutocompleteOverlayPosition | null,
): React.CSSProperties | undefined {
    if (!position) return undefined;
    return {
        left: `${position.left}px`,
        top: `${position.top}px`,
        bottom: 'auto',
        width: `min(${CARET_PLACED_WIDTH[kind]}px, calc(100% - ${position.left + 8}px))`,
        maxHeight: `${position.maxHeight}px`,
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
    onCommandSelect: (command: CommandInfo) => void;
    onSkillSelect: (skillName: string) => void;
    onSnippetSelect: (snippet: unknown, trigger: string) => void;
    onFileSelect: (file: { name: string; path: string; relativePath?: string }) => void;
    onAgentSelect: (agentName: string) => void;
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
                <GlassPopupMotion key={open} className="absolute inset-x-0 top-0 z-[100] h-0 origin-top-left">
                    <AutocompletePopup {...props} open={open} />
                </GlassPopupMotion>
            ) : null}
        </AnimatePresence>
    );
}

function AutocompletePopup(props: ComposerAutocompletePopupsProps & { open: AutocompleteKind }) {
    const { open, query, overlayPosition, onClose } = props;

    const style = caretStyle(open, overlayPosition);

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
                    onClose={onClose}
                    style={style}
                />
            );
    }
}

/** Memoized: the composer re-renders on every keystroke, and nothing here depends on the draft text. */
export const ComposerAutocompletePopups = React.memo(ComposerAutocompletePopupsView);
