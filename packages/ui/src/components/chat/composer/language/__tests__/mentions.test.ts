import { describe, expect, test } from 'bun:test';

import {
    classifyMention,
    cleanMentionName,
    confirmMention,
    dismissMention,
    isFileMentionCandidate,
    isMentionBoundary,
    isMentionDismissed,
    isMentionEntryInText,
    looksLikeFilePath,
    scanMentions,
} from '../mentions';

const names = (text: string) => scanMentions(text).map((token) => token.name);
const raws = (text: string) => scanMentions(text).map((token) => token.raw);

describe('scanMentions — boundaries', () => {
    test('a mention at the start of the text', () => {
        expect(names('@build do this')).toEqual(['build']);
    });

    test('a mention after whitespace', () => {
        expect(names('ask @build about it')).toEqual(['build']);
    });

    test('an email address is not a mention', () => {
        expect(names('write to me@example.com')).toEqual([]);
    });

    test('a scoped package is not a mention', () => {
        expect(names('install @scope/pkg')).toEqual(['scope/pkg']);
        expect(names('bump foo@scope/pkg')).toEqual([]);
    });

    test('opening punctuation still starts a mention', () => {
        expect(names('(@build) [@plan] {@x.ts} "@y.ts"')).toEqual(['build', 'plan', 'x.ts', 'y.ts']);
    });

    test('multiple mentions on one line', () => {
        expect(names('@a.ts and @b.ts')).toEqual(['a.ts', 'b.ts']);
    });

    test('mentions across lines', () => {
        expect(names('@a.ts\n@b.ts')).toEqual(['a.ts', 'b.ts']);
    });

    test('a bare @ is not a mention', () => {
        expect(names('call me @ noon')).toEqual([]);
    });

    test('a token that cleans away to nothing is skipped', () => {
        expect(names('@... and @`')).toEqual([]);
    });

    test('text without @ scans to nothing', () => {
        expect(scanMentions('plain text')).toEqual([]);
        expect(scanMentions('')).toEqual([]);
    });

    test('isMentionBoundary agrees with the scanner', () => {
        expect(isMentionBoundary('@a', 0)).toBe(true);
        expect(isMentionBoundary('x @a', 2)).toBe(true);
        expect(isMentionBoundary('x@a', 1)).toBe(false);
        expect(isMentionBoundary('1@a', 1)).toBe(false);
    });
});

describe('scanMentions — name cleanup', () => {
    test('trailing sentence punctuation is not part of the name', () => {
        expect(names('see @a/b.ts, then @c/d.ts.')).toEqual(['a/b.ts', 'c/d.ts']);
        expect(names('@x.ts! @y.ts? @z.ts;')).toEqual(['x.ts', 'y.ts', 'z.ts']);
    });

    test('wrapping quotes and brackets are stripped from both ends', () => {
        expect(names('`@a/b.ts`')).toEqual(['a/b.ts']);
        expect(names('(@a/b.ts)')).toEqual(['a/b.ts']);
        expect(names('<@a/b.ts>')).toEqual(['a/b.ts']);
    });

    test('the raw token still covers the punctuation the name dropped', () => {
        expect(raws('see @a/b.ts, ok')).toEqual(['@a/b.ts,']);
    });

    test('the reference span excludes brushing punctuation', () => {
        const text = 'see @a/b.ts, ok';
        const [token] = scanMentions(text);
        expect(text.slice(token.start, token.end)).toBe('@a/b.ts');
    });

    test('leading noise shifts the reference span past it', () => {
        const text = '`@a/b.ts`';
        const [token] = scanMentions(text);
        expect(text.slice(token.start, token.end)).toBe('@a/b.ts');
    });

    test('a trailing slash is kept — directories are mentionable', () => {
        expect(names('@src/components/')).toEqual(['src/components/']);
    });

    test('cleanMentionName is idempotent', () => {
        expect(cleanMentionName(cleanMentionName('`a/b.ts`,'))).toBe('a/b.ts');
    });
});

describe('scanMentions — offsets', () => {
    test('a clean token has identical reference and raw spans', () => {
        const text = 'ask @build now';
        const [token] = scanMentions(text);
        expect(text.slice(token.start, token.end)).toBe(token.raw);
        expect(token.start).toBe(4);
        expect(token.end).toBe(10);
    });
});

describe('classifyMention', () => {
    const classifier = {
        knownAgentNames: new Set(['build', 'plan']),
        confirmedMentions: new Set(['NOTES']),
    };

    test('a known agent name classifies as an agent', () => {
        expect(classifyMention('build', classifier)).toBe('agent');
    });

    test('agent matching is case-insensitive', () => {
        expect(classifyMention('Build', classifier)).toBe('agent');
    });

    test('a path-like name is only a candidate until it is confirmed', () => {
        expect(classifyMention('src/app.ts', classifier)).toBeNull();
        expect(isFileMentionCandidate('src/app.ts', classifier)).toBe(true);
        expect(isFileMentionCandidate('README.md', classifier)).toBe(true);
        expect(isFileMentionCandidate('win\\path', classifier)).toBe(true);
    });

    test('a picker-confirmed extensionless name classifies as a file', () => {
        expect(classifyMention('NOTES', classifier)).toBe('file');
    });

    test('an unknown bare word classifies as nothing', () => {
        expect(classifyMention('nothing', classifier)).toBeNull();
        expect(classifyMention('', classifier)).toBeNull();
    });

    test('HTML fragments do not classify as file references', () => {
        expect(classifyMention('import</style>', classifier)).toBeNull();
        expect(classifyMention('src/<style.css', classifier)).toBeNull();
    });

    test('an agent name wins over a file-looking name', () => {
        const shadowed = {
            knownAgentNames: new Set(['a.ts']),
            confirmedMentions: new Set<string>(),
        };
        expect(classifyMention('a.ts', shadowed)).toBe('agent');
        expect(isFileMentionCandidate('a.ts', shadowed)).toBe(false);
    });

    test('calls, URLs and versions are not shaped like a path until confirmed', () => {
        for (const name of [
            'app.route("/x', 'click="a.b', 'https://example.com/a', '1.2.3', 'v19.2.0-rc.1',
            'angular/core@19', 'scope.name@2',
        ]) {
            expect(looksLikeFilePath(name, new Set())).toBe(false);
            expect(looksLikeFilePath(name, new Set([name]))).toBe(true);
        }
    });

    test('brackets and an @ folder stay shaped like a path', () => {
        for (const name of ['app/(auth)/page.tsx', 'app/[id]/page.tsx', 'node_modules/@types/node/index.d.ts', 'v2.config.ts']) {
            expect(looksLikeFilePath(name, new Set())).toBe(true);
        }
    });

    test('a dismissed name is no reference until it is confirmed again', () => {
        const mentions = new Set(['src/app.ts']);
        const dismissed = { knownAgentNames: new Set(['build']), confirmedMentions: mentions };

        dismissMention('src/app.ts', mentions);
        dismissMention('build', mentions);
        expect(isMentionDismissed('src/app.ts', mentions)).toBe(true);
        expect(classifyMention('src/app.ts', dismissed)).toBeNull();
        expect(isFileMentionCandidate('src/app.ts', dismissed)).toBe(false);
        expect(classifyMention('Build', dismissed)).toBeNull();

        confirmMention('src/app.ts', mentions);
        confirmMention('build', mentions);
        expect(classifyMention('src/app.ts', dismissed)).toBe('file');
        expect(classifyMention('build', dismissed)).toBe('agent');
    });

    test('looksLikeFilePath is independent of the agent list', () => {
        expect(looksLikeFilePath('a/b', new Set())).toBe(true);
        expect(looksLikeFilePath('plain', new Set())).toBe(false);
        expect(looksLikeFilePath('plain', new Set(['plain']))).toBe(true);
    });
});

describe('isMentionEntryInText', () => {
    const entry = (name: string) => {
        const mentions = new Set<string>();
        dismissMention(name, mentions);
        return [...mentions][0]!;
    };

    test('a confirmed path must appear exactly', () => {
        expect(isMentionEntryInText('src/a.ts', 'see @src/a.ts')).toBe(true);
        expect(isMentionEntryInText('src/a.ts', 'see @SRC/a.ts')).toBe(false);
    });

    test('a dismissal lasts while its mention does, in any case', () => {
        expect(isMentionEntryInText(entry('build'), 'ask @Build now')).toBe(true);
        expect(isMentionEntryInText(entry('build'), 'ask nobody')).toBe(false);
    });
});

describe('scanMentions — dismissed paths with spaces', () => {
    test('a dismissed spaced path stays whole, so no part of it reads as a file', () => {
        const mentions = new Set(['docs/my file.md']);
        dismissMention('docs/my file.md', mentions);
        expect(scanMentions('see @docs/my file.md', mentions).map((token) => token.name)).toEqual(['docs/my file.md']);
        expect(isFileMentionCandidate('docs/my file.md', { knownAgentNames: new Set(), confirmedMentions: mentions })).toBe(false);
    });
});

describe('scanMentions — confirmed paths with spaces', () => {
    const confirmed = new Set(['docs/my document.md', 'docs/my document.md.bak', 'plain.ts']);

    test('a confirmed path keeps its spaces', () => {
        const tokens = scanMentions('read @docs/my document.md please', confirmed);
        expect(tokens.map((token) => token.name)).toEqual(['docs/my document.md']);
        expect(tokens[0]).toMatchObject({ start: 5, end: 25, raw: '@docs/my document.md' });
    });

    test('the longest confirmed path wins', () => {
        expect(scanMentions('@docs/my document.md.bak', confirmed).map((token) => token.name))
            .toEqual(['docs/my document.md.bak']);
    });

    test('a confirmed path must end at a boundary', () => {
        expect(scanMentions('@docs/my documentary', confirmed).map((token) => token.name)).toEqual(['docs/my']);
    });

    test('trailing punctuation ends a confirmed path', () => {
        expect(scanMentions('(@docs/my document.md), @plain.ts', confirmed).map((token) => token.name))
            .toEqual(['docs/my document.md', 'plain.ts']);
    });

    test('without the confirmed set the scan stops at whitespace', () => {
        expect(names('@docs/my document.md')).toEqual(['docs/my']);
    });
});
