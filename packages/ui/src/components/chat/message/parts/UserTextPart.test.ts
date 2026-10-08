import { describe, expect, test } from 'bun:test';

import { buildSkillHref } from '@/lib/messages/inlineMessageLinks';
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
});
