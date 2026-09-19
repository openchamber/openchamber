import { describe, expect, test } from 'bun:test';

import type { ComposerLanguageContext } from '../../language/tokenize';
import { extractProtectedTokens, validateProtectedTokensPreserved } from '../protectedTokens';

const context = (): ComposerLanguageContext => ({
    inputMode: 'normal',
    knownAgentNames: new Set(),
    confirmedMentions: new Set(),
    knownSlashNames: new Set(),
    knownSnippetTriggers: new Set(),
    attachmentFilenames: [],
});

const preserved = (source: string, result: string) =>
    validateProtectedTokensPreserved(source, result, context());

describe('extractProtectedTokens', () => {
    test('collects mentions, slash tokens and snippets', () => {
        const tokens = extractProtectedTokens('use @src/app.ts with /review and #notes', context());
        expect(tokens.mentions).toEqual(['src/app.ts']);
        expect(tokens.slash).toEqual(['/review']);
        expect(tokens.snippets).toEqual(['#notes']);
    });

    test('mentions are the punctuation-brushed name the editor resolves', () => {
        // A comma brushing against the mention is sentence punctuation, not
        // part of the reference — the same cleanup the editor applies.
        const tokens = extractProtectedTokens('check @src/app.ts, then deploy', context());
        expect(tokens.mentions).toEqual(['src/app.ts']);
    });

    test('deduplicates repeated tokens', () => {
        const tokens = extractProtectedTokens('/review twice, /review again', context());
        expect(tokens.slash).toEqual(['/review']);
    });

    test('plain prose yields empty lists', () => {
        const tokens = extractProtectedTokens('no tokens here, see a/b.ts and issue#42', context());
        expect(tokens).toEqual({ mentions: [], slash: [], snippets: [] });
    });
});

describe('validateProtectedTokensPreserved — surviving tokens', () => {
    test('a mention present in both source and result passes', () => {
        expect(preserved('check @src/app.ts please', 'please check @src/app.ts now')).toBe(true);
    });

    test('a mention whose trailing punctuation was rewritten away passes', () => {
        // The editor resolves "@src/app.ts," to the same mention as
        // "@src/app.ts" — re-punctuating the sentence around the reference is
        // not losing it.
        expect(preserved('check @src/app.ts, then deploy', 'check the app, @src/app.ts')).toBe(true);
    });

    test('a rewrite that actually drops the mention still fails', () => {
        expect(preserved('check @src/app.ts, then deploy', 'check the app, then deploy')).toBe(false);
    });

    test('a snippet present in both passes even when moved', () => {
        expect(preserved('use #notes here', 'here, use #notes instead')).toBe(true);
    });

    test('a slash command present in both passes', () => {
        expect(preserved('run /review on it', 'on it, run /review')).toBe(true);
    });

    test('slash comparison is case-insensitive', () => {
        expect(preserved('run /Review on it', 'run /review now')).toBe(true);
    });

    test('mentions are case-sensitive', () => {
        expect(preserved('ask @Build agent', 'ask @build agent')).toBe(false);
    });

    test('snippets are case-sensitive', () => {
        expect(preserved('use #Notes', 'use #notes')).toBe(false);
    });
});

describe('validateProtectedTokensPreserved — corrupted tokens', () => {
    test('a dropped mention fails', () => {
        expect(preserved('check @src/app.ts please', 'check the app file please')).toBe(false);
    });

    test('an altered mention fails', () => {
        expect(preserved('check @src/app.ts please', 'check @src/app.tsx please')).toBe(false);
    });

    test('a dropped slash command fails', () => {
        expect(preserved('run /review on it', 'review it')).toBe(false);
    });

    test('an altered snippet fails', () => {
        expect(preserved('use #notes', 'use #note')).toBe(false);
    });
});

describe('validateProtectedTokensPreserved — invented tokens', () => {
    test('a new mention in the result fails', () => {
        expect(preserved('plain prose only', 'prose with @src/file.ts added')).toBe(false);
    });

    test('a new snippet in the result fails', () => {
        expect(preserved('plain prose only', 'prose with #invented added')).toBe(false);
    });

    test('a new slash command in the result fails', () => {
        expect(preserved('run /review', 'run /review then /debug')).toBe(false);
    });

    test('a slash token invented by the rewrite fails even when the source used none', () => {
        // No kind may be invented: with the source naming no command, the
        // model must not introduce one of its own.
        expect(preserved('plain prose', 'prose with /debug inside')).toBe(false);
    });
});

describe('validateProtectedTokensPreserved — empty source lists', () => {
    test('no mentions in the source and none in the result passes', () => {
        expect(preserved('run /review', 'run the review command /review')).toBe(true);
    });

    test('no protected tokens anywhere passes', () => {
        expect(preserved('plain prose', 'rewritten prose')).toBe(true);
    });
});

describe('validateProtectedTokensPreserved — duplicates', () => {
    test('the same token twice in the source and once in the result passes', () => {
        expect(preserved('/review once /review twice', 'single /review run')).toBe(true);
    });

    test('one of two distinct source tokens lost fails', () => {
        expect(preserved('/review and /debug', 'only /review remains')).toBe(false);
    });
});
