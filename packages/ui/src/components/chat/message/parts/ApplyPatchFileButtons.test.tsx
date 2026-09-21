import { describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { EditorAPI } from '@/lib/api/types';

import { ApplyPatchFileButtons } from './ApplyPatchFileButtons';
import { openApplyPatchFileInEditor } from './applyPatchEditorAction';

const makePatch = (path: string, line: number, before: string, after: string) => [
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${line} +${line} @@`,
    `-${before}`,
    `+${after}`,
].join('\n');

const files = [
    {
        filePath: '/workspace/project/src/first.ts',
        relativePath: 'src/first.ts',
        patch: makePatch('src/first.ts', 4, 'first old', 'first new'),
        additions: 1,
        deletions: 1,
        type: 'update',
    },
    {
        filePath: '/workspace/project/src/second.ts',
        relativePath: 'src/second.ts',
        patch: makePatch('src/second.ts', 12, 'second old', 'second new'),
        additions: 1,
        deletions: 1,
        type: 'update',
    },
];

describe('ApplyPatchFileButtons', () => {
    test('renders one labeled button per non-deleted file', () => {
        const markup = renderToStaticMarkup(
            <ApplyPatchFileButtons
                metadata={{ files }}
                openDiffLabel="Open file diff"
                onFileClick={() => undefined}
            />,
        );

        expect(markup.match(/<button/g)).toHaveLength(2);
        expect(markup).toContain('aria-label="Open file diff: src/first.ts"');
        expect(markup).toContain('aria-label="Open file diff: src/second.ts"');
    });

    test('opens each clicked file with its own authoritative path, patch, and line', () => {
        const openDiffCalls: Parameters<EditorAPI['openDiff']>[] = [];
        const editor: EditorAPI = {
            openDiff: async (...args) => { openDiffCalls.push(args); },
            openFile: async () => undefined,
        };
        let propagationStops = 0;
        const stopPropagation = () => { propagationStops += 1; };
        const tree = ApplyPatchFileButtons({
            metadata: { files },
            openDiffLabel: 'Open file diff',
            onFileClick: (file, event) => {
                event.stopPropagation();
                const targetPath = typeof file.relativePath === 'string' ? file.relativePath : '';
                openApplyPatchFileInEditor({
                    currentDirectory: '/workspace/project',
                    diffLabel: `${targetPath} (changes)`,
                    editor,
                    file,
                    isVSCode: true,
                });
            },
        }) as React.ReactElement<{ children: React.ReactNode }>;
        const buttons = React.Children.toArray(tree.props.children) as React.ReactElement<{
            onClick: (event: { stopPropagation: () => void }) => void;
        }>[];

        buttons[0]?.props.onClick({ stopPropagation });
        buttons[1]?.props.onClick({ stopPropagation });

        expect(propagationStops).toBe(2);
        expect(openDiffCalls).toEqual([
            ['', '/workspace/project/src/first.ts', 'src/first.ts (changes)', {
                line: 4,
                patch: files[0]?.patch,
            }],
            ['', '/workspace/project/src/second.ts', 'src/second.ts (changes)', {
                line: 12,
                patch: files[1]?.patch,
            }],
        ]);
    });
});
