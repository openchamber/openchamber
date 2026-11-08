import { describe, expect, test } from 'bun:test';

import { matchSnippetTrigger, resolveAutocompleteTrigger, type TriggerContext } from '../triggers';

const normal: TriggerContext = { inputMode: 'normal' };

/** Resolve with the caret placed at the `|` marker in `text`. */
const at = (text: string, context: TriggerContext = normal) => {
    const cursor = text.indexOf('|');
    if (cursor === -1) throw new Error('caret marker `|` missing');
    return resolveAutocompleteTrigger(text.replace('|', ''), cursor, context);
};

describe('command palette', () => {
    test('a leading slash opens the command palette', () => {
        expect(at('/rev|')).toEqual({ kind: 'command', query: 'rev' });
    });

    test('a bare leading slash opens it with an empty query', () => {
        expect(at('/|')).toEqual({ kind: 'command', query: '' });
    });

    test('a space anywhere turns it into an invocation, not a search', () => {
        expect(at('/review |')?.kind).not.toBe('command');
        expect(at('/rev|iew now')?.kind).not.toBe('command');
    });

    test('the caret must stay inside the command word', () => {
        expect(at('/review\nnext line|')?.kind).not.toBe('command');
    });

    test('a slash that is not in the first column opens nothing', () => {
        expect(at(' /rev|')).toBeNull();
        expect(at('please run /explo|')).toBeNull();
        expect(at('line\n/pl|')).toBeNull();
    });
});

describe('skill picker', () => {
    test('a dollar at the start of the text opens the skill picker', () => {
        expect(at('$rev|')).toEqual({ kind: 'skill', query: 'rev' });
        expect(at('$|')).toEqual({ kind: 'skill', query: '' });
    });

    test('a dollar after whitespace opens it', () => {
        expect(at('please run $explo|')).toEqual({ kind: 'skill', query: 'explo' });
    });

    test('a dollar after a newline opens it', () => {
        expect(at('line\n$pl|')).toEqual({ kind: 'skill', query: 'pl' });
    });

    test('the sigils a CJK IME produces open it too', () => {
        expect(at('¥rev|')).toEqual({ kind: 'skill', query: 'rev' });
        expect(at('￥rev|')).toEqual({ kind: 'skill', query: 'rev' });
        expect(at('＄rev|')).toEqual({ kind: 'skill', query: 'rev' });
    });

    test('an IME sigil after whitespace opens it', () => {
        expect(at('please run ¥explo|')).toEqual({ kind: 'skill', query: 'explo' });
    });

    test('the nearest sigil wins across spellings', () => {
        expect(at('$a ¥c|')).toEqual({ kind: 'skill', query: 'c' });
    });

    test('a dollar inside a word does not open it', () => {
        expect(at('US$5|')).toBeNull();
    });

    test('a space after the sigil closes it', () => {
        expect(at('run $explore |')).toBeNull();
    });

    test('the nearest dollar before the caret wins', () => {
        expect(at('$a b $c|')).toEqual({ kind: 'skill', query: 'c' });
    });

    test('works after a command invocation', () => {
        expect(at('/review $pl|')).toEqual({ kind: 'skill', query: 'pl' });
    });
});

describe('snippet picker', () => {
    test('a hash after whitespace opens the snippet picker', () => {
        expect(at('use #sig|')).toEqual({ kind: 'snippet', query: 'sig' });
    });

    test('a hash at the start of the text opens it', () => {
        expect(at('#sig|')).toEqual({ kind: 'snippet', query: 'sig' });
    });

    test('an issue reference does not open it', () => {
        expect(at('issue#42|')).toBeNull();
    });

    test('a dollar outranks a hash when both are candidates', () => {
        expect(at('#tag $skill|')).toEqual({ kind: 'skill', query: 'skill' });
    });
});

describe('mention picker', () => {
    test('an at-sign after whitespace opens the mention picker', () => {
        expect(at('see @src/ap|')).toEqual({ kind: 'mention', query: 'src/ap' });
    });

    test('a bare at-sign opens it with an empty query', () => {
        expect(at('@|')).toEqual({ kind: 'mention', query: '' });
    });

    test('an email address does not open it', () => {
        expect(at('me@example|')).toBeNull();
    });

    test('a space after the sigil closes it', () => {
        expect(at('@build now|')).toBeNull();
    });

    test('a space keeps it open while the query still names a session', () => {
        const sessions: TriggerContext = {
            inputMode: 'normal',
            mentionContinuesPastSpace: (query) => 'release notes'.startsWith(query.toLowerCase()),
        };
        expect(at('see @Release no|', sessions)).toEqual({ kind: 'mention', query: 'Release no' });
        expect(at('@release |', sessions)).toEqual({ kind: 'mention', query: 'release ' });
        expect(at('@release notes are|', sessions)).toBeNull();
        expect(at('@ release|', sessions)).toBeNull();
        expect(at('@release\nnotes|', sessions)).toBeNull();
    });

    test('a pasted at-sign does not open the picker', () => {
        expect(at('@src/app.ts|', {
            inputMode: 'normal',
            inputSource: 'paste',
            insertedText: '@src/app.ts',
        })).toBeNull();
    });

    test('a paste without an at-sign still resolves normally', () => {
        expect(at('@src|', {
            inputMode: 'normal',
            inputSource: 'paste',
            insertedText: 'src',
        })).toEqual({ kind: 'mention', query: 'src' });
    });
});

describe('precedence and disabling', () => {
    test('shell mode disables every picker', () => {
        const shell: TriggerContext = { inputMode: 'shell' };
        expect(at('/rev|', shell)).toBeNull();
        expect(at('$rev|', shell)).toBeNull();
        expect(at('@src|', shell)).toBeNull();
        expect(at('#sig|', shell)).toBeNull();
    });

    test('a leading slash opens commands only, never the skill picker', () => {
        expect(at('/pl|')).toEqual({ kind: 'command', query: 'pl' });
    });

    test('plain prose triggers nothing', () => {
        expect(at('just typing a sentence|')).toBeNull();
        expect(at('|')).toBeNull();
    });
});


test('BTW leaves file and agent references as text while retaining other pickers', () => {
    const btw: TriggerContext = { inputMode: 'normal', mentionsEnabled: false };
    expect(at('@src/file|', btw)).toBeNull();
    expect(at('@plan|', btw)).toBeNull();
    expect(at('#snippet|', btw)).toEqual({ kind: 'snippet', query: 'snippet' });
    expect(at('@plan|')?.kind).toBe('mention');
});

describe('matchSnippetTrigger', () => {
    const snippetAt = (text: string) => matchSnippetTrigger(text.replace('|', ''), text.indexOf('|'));

    test('reads the query after a # at a word boundary', () => {
        expect(snippetAt('please #rev|')).toBe('rev');
        expect(snippetAt('#|')).toBe('');
    });

    test('ignores a # inside a word or a finished token', () => {
        expect(snippetAt('issue#12|')).toBeNull();
        expect(snippetAt('#review done|')).toBeNull();
    });
});

describe('emoji trigger', () => {
    test('opens on a typed colon and two letters at a word boundary', () => {
        expect(at('shipped :ta|')).toEqual({ kind: 'emoji', query: 'ta' });
        expect(at(':+1|')).toEqual({ kind: 'emoji', query: '+1' });
        expect(at(':Party|')).toEqual({ kind: 'emoji', query: 'party' });
    });

    test('stays shut for times, links, key: value, smileys and finished shortcodes', () => {
        expect(at('at 12:30|')).toBeNull();
        expect(at('http://ex|')).toBeNull();
        expect(at('key: value|')).toBeNull();
        expect(at(':D|')).toBeNull();
        expect(at(':tada:|')).toBeNull();
        expect(at('a :ta|', { inputMode: 'shell' })).toBeNull();
        expect(at('a :ta|', { inputMode: 'normal', inputSource: 'paste' })).toBeNull();
    });

    test('a mention outranks it', () => {
        expect(at('@ab:cd|')?.kind).toBe('mention');
    });
});
