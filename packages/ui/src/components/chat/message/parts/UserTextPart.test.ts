import { describe, expect, test } from 'bun:test';

import { buildSkillHref } from '@/lib/messages/inlineMessageLinks';
import type { Part } from '@/lib/opencode/model';
import { CONTEXT_METADATA_KEY } from '@/lib/messages/contextParts';
import { sessionMentionChipsOf } from './sessionMentionChips';
import { prepareUserMarkdownContent } from './userTextPartContent';

describe('prepareUserMarkdownContent', () => {
    test('keeps fenced code < and -> unescaped for the markdown renderer', () => {
        const content = prepareUserMarkdownContent({
            textContent: '```rust\nlet values: Vec<i32> = vec![];\nlet next = old -> new;\n```',
            skillNames: new Set(),
        });

        expect(content).toContain('Vec<i32>');
        expect(content).toContain('old -> new');
        expect(content).not.toContain('&lt;');
        expect(content).not.toContain('-&gt;');
    });

    test('escapes raw HTML outside fences so tags display as text', () => {
        const content = prepareUserMarkdownContent({
            textContent: 'Use <b>bold</b> and <script>alert("x")</script>',
            skillNames: new Set(),
        });

        expect(content).toContain('&lt;b&gt;bold&lt;/b&gt;');
        expect(content).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
        expect(content).not.toContain('<b>bold</b>');
        expect(content).not.toContain('<script>');
    });

    test('links $skill and the older /skill form, leaving unknown names as text', () => {
        const content = prepareUserMarkdownContent({
            textContent: '$review then /review, not $5 or $other',
            skillNames: new Set(['review']),
        });

        expect(content.split(`](${buildSkillHref('review')})`)).toHaveLength(3);
        expect(content).toContain('not $5 or $other');
    });

    test('links a skill typed with the sigils a CJK IME produces', () => {
        const content = prepareUserMarkdownContent({
            textContent: '¥review ￥review ＄review',
            skillNames: new Set(['review']),
        });

        expect(content.split(`](${buildSkillHref('review')})`)).toHaveLength(4);
    });

    test('adds hard line breaks outside fences but not inside', () => {
        const content = prepareUserMarkdownContent({
            textContent: 'first\nsecond\n```ts\nconst x = 1\nconst y = 2\n```\nthird',
            skillNames: new Set(),
        });

        expect(content).toContain('first  \nsecond  \n```ts\n');
        expect(content).toContain('const x = 1\nconst y = 2\n```  \nthird');
        expect(content).not.toContain('const x = 1  \nconst y = 2');
    });

    test('escapes a message that is only a list marker so the sign shows', () => {
        for (const textContent of ['+', '-', '*', '  +  ', '\n-\n', '*\n']) {
            const content = prepareUserMarkdownContent({ textContent, skillNames: new Set() });
            expect(content).toBe(`\\${textContent.trim()}`);
        }
    });

    test('leaves real lists and longer messages with a lone marker line alone', () => {
        const prepare = (textContent: string) => prepareUserMarkdownContent({ textContent, skillNames: new Set() });

        expect(prepare('- item')).toBe('- item');
        expect(prepare('++')).toBe('++');
        expect(prepare('--')).toBe('--');
        expect(prepare('looks good\n+')).toBe('looks good  \n+');
    });

    test('preserves mention conversion', () => {
        const content = prepareUserMarkdownContent({
            textContent: '@agent hello\n/skill-name',
            agentMention: { name: 'build-agent', token: '@agent' },
            skillNames: new Set(['skill-name']),
        });

        expect(content).toContain('[@agent](#openchamber-agent:build-agent)');
        expect(content).toContain('[/skill-name](#openchamber-skill:skill-name)');
        expect(content).toContain('hello  \n[/skill-name]');
    });

    test('turns citations of the message attachments into attachment links', () => {
        const content = prepareUserMarkdownContent({
            textContent: 'Look at [OpenChamber_2026@2x.png] and [notes], see [docs](https://example.com)',
            skillNames: new Set(),
            attachments: [{ filename: 'OpenChamber_2026@2x.png', iconId: 'png' }],
        });

        expect(content).toContain('[OpenChamber\\_2026@2x.png](#openchamber-attachment:png:OpenChamber_2026%402x.png)');
        expect(content).toContain('[notes]');
        expect(content).toContain('[docs](https://example.com)');
    });

    test('leaves citations inside fenced code untouched', () => {
        const content = prepareUserMarkdownContent({
            textContent: '```\n[shot.png]\n```',
            skillNames: new Set(),
            attachments: [{ filename: 'shot.png', iconId: 'png' }],
        });

        expect(content).toContain('```\n[shot.png]\n```');
    });

    test('a mentioned session link becomes a link labelled with its chip; one not mentioned stays text', () => {
        // SAFETY: the context parts a sent message carries; chips read their metadata only.
        const parts = [
            { id: 'p1', sessionID: 's', messageID: 'm', type: 'text', text: 'ctx', metadata: { [CONTEXT_METADATA_KEY]: { kind: 'session', sessionId: 'ses_a', title: 'Tweet *writing*' } } },
            { id: 'p2', sessionID: 's', messageID: 'm', type: 'text', text: 'ctx', metadata: { [CONTEXT_METADATA_KEY]: { kind: 'session-message', sessionId: 'ses_a', messageId: 'msg_1', sessionTitle: 'T', excerpt: 'Draft three' } } },
        ] as Part[];
        const chips = sessionMentionChipsOf(parts);
        const content = prepareUserMarkdownContent({
            textContent: 'see openchamber://session/ses_a and https://chamber.example/?session=ses_a&message=msg_1, not openchamber://session/ses_b',
            skillNames: new Set(),
            sessionMentions: { chips, origins: ['https://chamber.example'] },
        });
        expect(content).toBe('see [Tweet \\*writing\\*](<openchamber://session/ses_a>) and [Draft three](<https://chamber.example/?session=ses_a&message=msg_1>)\u2060, not openchamber://session/ses_b');
    });

    test('a mentioned link the user already linked, or put in code, is left as written; a backslash cannot break out', () => {
        // SAFETY: a context part a sent message carries; chips read its metadata only.
        const parts = [{ id: 'p1', sessionID: 's', messageID: 'm', type: 'text', text: 'ctx', metadata: { [CONTEXT_METADATA_KEY]: { kind: 'session', sessionId: 'ses_a', title: 'A' } } }] as Part[];
        const sessionMentions = { chips: sessionMentionChipsOf(parts), origins: ['https://own.example'] };
        const content = prepareUserMarkdownContent({
            textContent: '[this](https://own.example/?session=ses_a) and `openchamber://session/ses_a` and https://own.example/?session=ses_a&x=a\\',
            skillNames: new Set(),
            sessionMentions,
        });
        expect(content).toBe('[this](https://own.example/?session=ses_a) and `openchamber://session/ses_a` and [A](<https://own.example/?session=ses_a&x=a%5C>)');
    });

    test('a chip and the punctuation after it are joined, so the line never breaks between them', () => {
        // SAFETY: a context part a sent message carries; chips read its metadata only.
        const parts = [{ id: 'p1', sessionID: 's', messageID: 'm', type: 'text', text: 'ctx', metadata: { [CONTEXT_METADATA_KEY]: { kind: 'session', sessionId: 'ses_a', title: 'A' } } }] as Part[];
        const content = prepareUserMarkdownContent({
            textContent: 'see openchamber://session/ses_a, then openchamber://session/ses_a next',
            skillNames: new Set(),
            sessionMentions: { chips: sessionMentionChipsOf(parts), origins: [] },
        });
        expect(content).toBe('see [A](<openchamber://session/ses_a>)\u2060, then [A](<openchamber://session/ses_a>) next');
    });
});
