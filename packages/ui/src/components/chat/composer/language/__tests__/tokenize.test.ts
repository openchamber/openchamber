import { describe, expect, test } from 'bun:test';

import { buildHighlightParts } from '../../../composerHighlight';
import {
    tokenizeComposer,
    tokenizeMentions,
    type ComposerLanguageContext,
} from '../tokenize';

const context = (overrides: Partial<ComposerLanguageContext> = {}): ComposerLanguageContext => ({
    inputMode: 'normal',
    knownAgentNames: new Set(['build', 'plan']),
    confirmedMentions: new Set(['NOTES']),
    knownSlashNames: new Set(['review', 'explore']),
    knownSnippetTriggers: new Set(['sig']),
    attachmentFilenames: [],
    ...overrides,
});

/** The substring and style of every range, sorted for stable comparison. */
const styled = (text: string, ctx = context()) =>
    tokenizeComposer(text, ctx)
        .map((range) => [text.slice(range.start, range.end), range.style] as const)
        .sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));

const stylesOf = (text: string, ctx = context()) =>
    new Set(tokenizeComposer(text, ctx).map((range) => range.style));

describe('tokenizeComposer — reference constructs', () => {
    test('a known agent mention is styled as an agent', () => {
        expect(styled('ask @build please')).toEqual([['@build', 'mentionAgent']]);
    });

    test('a path mention is styled as a file', () => {
        expect(styled('see @src/app.ts')).toEqual([['@src/app.ts', 'mentionFile']]);
    });

    test('an unknown bare mention is not tokenized', () => {
        expect(styled('hi @stranger')).toEqual([]);
    });

    test('a known slash token is styled as a command', () => {
        expect(styled('run /review now')).toEqual([['/review', 'mentionCommand']]);
    });

    test('an unknown slash token stays plain prose', () => {
        expect(styled('run /nosuchthing now')).toEqual([]);
    });

    test('a known snippet trigger is styled as a snippet', () => {
        expect(styled('end with #sig')).toEqual([['#sig', 'mentionSnippet']]);
    });

    test('an attachment citation is styled as a file', () => {
        expect(styled('here [shot.png]', context({ attachmentFilenames: ['shot.png'] })))
            .toEqual([['[shot.png]', 'mentionFile']]);
    });

    test('a citation for a file that is not attached is not tokenized', () => {
        expect(styled('here [other.png]', context({ attachmentFilenames: ['shot.png'] })))
            .toEqual([]);
    });
});

describe('tokenizeComposer — a path is highlighted but never attached', () => {
    test('a ~path is styled', () => {
        expect(styled('see ~src/app.ts')).toEqual([['~src/app.ts', 'path']]);
    });

    test('it needs no registry and no confirmation, unlike @', () => {
        // The same path behind `@` only resolves because it looks like a path;
        // behind `~` it is inert either way.
        const empty = context({ knownAgentNames: new Set(), confirmedMentions: new Set() });
        expect(styled('~docs/NOTES', empty)).toEqual([['~docs/NOTES', 'path']]);
    });

    test('an @mention covering the same text keeps its own style', () => {
        expect(styled('@src/app.ts')).toEqual([['@src/app.ts', 'mentionFile']]);
    });

    test('both forms can appear in one message', () => {
        expect(stylesOf('attach @a/b.ts but only mention ~c/d.ts'))
            .toEqual(new Set(['mentionFile', 'path']));
    });
});

describe('tokenizeComposer — emphasis and attention', () => {
    test('emphasis is tokenized', () => {
        expect(stylesOf('**bold** and *slanted*'))
            .toEqual(new Set(['marker', 'strong', 'emphasis']));
    });

    test('an attention line is tokenized', () => {
        expect(stylesOf('!!! read this')).toEqual(new Set(['marker', 'attention']));
    });

    test('shell mode still disables everything', () => {
        expect(tokenizeComposer('**bold** ~a/b.ts !!! x', context({ inputMode: 'shell' })))
            .toEqual([]);
    });
});

describe('tokenizeComposer — markdown still applies', () => {
    test('markdown and references coexist in one pass', () => {
        expect(stylesOf('# Title\n- see @src/app.ts and /review'))
            .toEqual(new Set(['marker', 'heading', 'listMarker', 'mentionFile', 'mentionCommand']));
    });

    test('fenced code is tokenized', () => {
        expect(stylesOf('```\nplain\n```').has('codeFence')).toBe(true);
    });
});

describe('tokenizeComposer — disabled and empty paths', () => {
    test('shell mode tokenizes nothing', () => {
        expect(tokenizeComposer('@build /review #sig', context({ inputMode: 'shell' })))
            .toEqual([]);
    });

    test('empty text tokenizes nothing', () => {
        expect(tokenizeComposer('', context())).toEqual([]);
    });

    test('empty registries leave their sigils plain', () => {
        expect(styled('/review #sig', context({
            knownSlashNames: new Set(),
            knownSnippetTriggers: new Set(),
        }))).toEqual([]);
    });
});

describe('tokenizeComposer — ranges are usable', () => {
    test('every range indexes real text', () => {
        const text = '# H\n@src/a.ts /review #sig `code` [x.png]';
        const ctx = context({ attachmentFilenames: ['x.png'] });
        for (const range of tokenizeComposer(text, ctx)) {
            expect(range.start >= 0).toBe(true);
            expect(range.end <= text.length).toBe(true);
            expect(range.end > range.start).toBe(true);
        }
    });

    test('the ranges reconstruct the text exactly through buildHighlightParts', () => {
        const text = 'ping @build about /review\n> quoted `code`';
        const parts = buildHighlightParts(text, tokenizeComposer(text, context()));
        expect(parts).not.toBeNull();
        expect(parts!.map((part) => part.text).join('')).toBe(text);
    });

    test('a mention inside inline code keeps the mention style', () => {
        // Mentions outrank code in the priority table, so a referenced path
        // stays recognizable even when the user wrapped it in backticks.
        const text = '`@src/app.ts`';
        const parts = buildHighlightParts(text, tokenizeComposer(text, context()));
        expect(parts!.map((part) => part.text)).toEqual(['`', '@src/app.ts', '`']);
    });
});

describe('tokenizeMentions', () => {
    test('classifies agents and files, skipping unknown words', () => {
        expect(tokenizeMentions('@build @src/a.ts @nobody', {
            knownAgentNames: new Set(['build']),
            confirmedMentions: new Set(),
        })).toEqual([
            { start: 0, end: 6, kind: 'agent' },
            { start: 7, end: 16, kind: 'file' },
        ]);
    });

    test('a picker-confirmed extensionless name counts as a file', () => {
        expect(tokenizeMentions('@NOTES', {
            knownAgentNames: new Set(),
            confirmedMentions: new Set(['NOTES']),
        })).toEqual([{ start: 0, end: 6, kind: 'file' }]);
    });
});
