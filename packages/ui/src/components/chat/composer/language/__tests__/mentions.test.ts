import { describe, expect, test } from 'bun:test';

import {
    classifyMention,
    cleanMentionName,
    isMentionBoundary,
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

    test('a path-like name classifies as a file', () => {
        expect(classifyMention('src/app.ts', classifier)).toBe('file');
        expect(classifyMention('README.md', classifier)).toBe('file');
        expect(classifyMention('win\\path', classifier)).toBe('file');
    });

    test('a scoped-package shape from a pasted log is not a file (#3929)', () => {
        // `ng build @servoy/public`, `pnpm add @angular/core` — one segment, a
        // slash, one more segment, no extension: a package/target, not a file.
        expect(classifyMention('servoy/public', classifier)).toBeNull();
        expect(classifyMention('angular/core', classifier)).toBeNull();
    });

    test('a scoped shape still classifies as a file when confirmed or extended', () => {
        // A real extension or deeper nesting is a genuine path.
        expect(classifyMention('servoy/public.ts', classifier)).toBe('file');
        expect(classifyMention('scope/pkg/index', classifier)).toBe('file');
        // A trailing slash names a directory (`@src/utils/`) and is a file
        // reference, not a package: the empty final segment breaks the shape.
        expect(classifyMention('src/utils/', classifier)).toBe('file');
        // Picked deliberately through the composer, so honour it.
        const confirmed = {
            knownAgentNames: new Set<string>(),
            confirmedMentions: new Set(['servoy/public']),
        };
        expect(classifyMention('servoy/public', confirmed)).toBe('file');
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
    });

    test('looksLikeFilePath is independent of the agent list', () => {
        // `a/b` is a bare two-segment shape (a scoped package), so it is not a
        // path unless the user confirmed it.
        expect(looksLikeFilePath('a/b', new Set())).toBe(false);
        expect(looksLikeFilePath('a/b', new Set(['a/b']))).toBe(true);
        expect(looksLikeFilePath('a/b.ts', new Set())).toBe(true);
        expect(looksLikeFilePath('plain', new Set())).toBe(false);
        expect(looksLikeFilePath('plain', new Set(['plain']))).toBe(true);
    });
});
