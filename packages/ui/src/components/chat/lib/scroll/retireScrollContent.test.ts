import { describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { retireScrollContent } from './retireScrollContent';

describe('retired timeline content', () => {
    test('waits for detachment and releases descendants without an animation frame', async () => {
        const window = new Window();
        const node = window.document.createElement('div');
        node.innerHTML = '<section><p>Old conversation</p></section>';
        window.document.body.append(node);

        retireScrollContent(node, () => false);
        expect(node.childElementCount).toBe(1);
        node.remove();
        await Promise.resolve();

        expect(node.childNodes.length).toBe(0);
    });

    test('preserves a connected tree during ref replacement', async () => {
        const window = new Window();
        const node = window.document.createElement('div');
        node.textContent = 'Visible conversation';
        window.document.body.append(node);

        retireScrollContent(node, () => false);
        await Promise.resolve();

        expect(node.textContent).toBe('Visible conversation');
    });

    test('preserves a reclaimed node even when its host is not attached yet', async () => {
        const window = new Window();
        const node = window.document.createElement('div');
        node.textContent = 'Mount in progress';
        let current = false;

        retireScrollContent(node, () => current);
        current = true;
        await Promise.resolve();

        expect(node.textContent).toBe('Mount in progress');
    });

    test('preserves a tree reattached before the commit completes', async () => {
        const window = new Window();
        const node = window.document.createElement('div');
        node.textContent = 'Moved conversation';

        retireScrollContent(node, () => false);
        window.document.body.append(node);
        await Promise.resolve();

        expect(node.textContent).toBe('Moved conversation');
    });

    test('leaves Markdown nodes transferred to a cache intact', async () => {
        const window = new Window();
        const node = window.document.createElement('div');
        const markdown = window.document.createElement('p');
        markdown.textContent = 'Cached paragraph';
        node.append(markdown, window.document.createElement('footer'));
        const cache = window.document.createDocumentFragment();

        retireScrollContent(node, () => false);
        cache.append(markdown);
        await Promise.resolve();

        expect(node.childNodes.length).toBe(0);
        expect(cache.firstChild).toBe(markdown);
        expect(markdown.textContent).toBe('Cached paragraph');
    });

    test('retained event targets do not accumulate retired conversation trees', async () => {
        const window = new Window();
        const retainedTargets = [];
        for (let index = 0; index < 100; index++) {
            const node = window.document.createElement('div');
            node.innerHTML = '<section><p>Message</p><button>Copy</button></section>';
            window.document.body.append(node);
            retainedTargets.push(node);
            retireScrollContent(node, () => false);
            node.remove();
        }
        await Promise.resolve();

        expect(retainedTargets.every((node) => node.childNodes.length === 0)).toBe(true);
    });
});
