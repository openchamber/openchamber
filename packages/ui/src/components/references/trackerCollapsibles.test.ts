import { expect, test } from 'bun:test';

import { foldTrackerCollapsibles } from './trackerCollapsibles';

test('a +++ section becomes a closed disclosure with its title', () => {
    const body = 'Done when it ships.\n\n+++ Agent notes\n\n- Load the `x` skill.\n\n+++\n\nAfter.';
    expect(foldTrackerCollapsibles(body)).toBe(
        'Done when it ships.\n\n<details>\n<summary>Agent notes</summary>\n\n\n- Load the `x` skill.\n\n\n</details>\n\nAfter.',
    );
});

test('the title is text, never markup or a Markdown link', () => {
    expect(foldTrackerCollapsibles('+++ <img src=x onerror=1> & "q"\nbody\n+++')).toContain(
        '<summary>&lt;img src=x onerror=1&gt; &amp; &quot;q&quot;</summary>',
    );
    expect(foldTrackerCollapsibles('+++ [site](https://x.test)\nbody\n+++')).toContain(
        '<summary>&#91;site&#93;&#40;https://x.test&#41;</summary>',
    );
});

test('a code block in a list item, or one opened with an info string inside it, stays as written', () => {
    const listed = '- step\n  ```diff\n  +++ b/a.ts\n  ```\n- next\n+++\n';
    expect(foldTrackerCollapsibles(listed)).toBe(listed);
    const infoInside = '```md\n+++ Notes\n```js\nx\n+++\n```';
    expect(foldTrackerCollapsibles(infoInside)).toBe(infoInside);
});

test('an unclosed section, a bare +++ and +++ inside a code block stay as written', () => {
    const unclosed = '+++ Notes\nbody';
    expect(foldTrackerCollapsibles(unclosed)).toBe(unclosed);
    const bare = 'a\n+++\nb';
    expect(foldTrackerCollapsibles(bare)).toBe(bare);
    const fenced = '```diff\n+++ b/a.ts\n-old\n+++\n```';
    expect(foldTrackerCollapsibles(fenced)).toBe(fenced);
});

test('two sections in a row both fold', () => {
    const folded = foldTrackerCollapsibles('+++ One\na\n+++\n+++ Two\nb\n+++');
    expect(folded.match(/<details>/g)).toHaveLength(2);
    expect(folded).toContain('<summary>Two</summary>');
});
