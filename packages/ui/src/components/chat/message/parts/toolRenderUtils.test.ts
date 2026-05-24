import { describe, expect, test } from 'bun:test';

import { isExpandableTool, isStandaloneTool } from './toolRenderUtils';

describe('toolRenderUtils', () => {
    test('keeps built-in expandable tools expandable', () => {
        expect(isExpandableTool('bash')).toBe(true);
        expect(isExpandableTool('write')).toBe(true);
        expect(isExpandableTool('question')).toBe(true);
    });

    test('keeps task standalone', () => {
        expect(isStandaloneTool('task')).toBe(true);
        expect(isStandaloneTool('functions.task:1')).toBe(true);
        expect(isExpandableTool('task')).toBe(false);
    });

    test('makes built-in summary tools expandable for input and output inspection', () => {
        expect(isExpandableTool('read')).toBe(true);
        expect(isExpandableTool('functions.read:1')).toBe(true);
        expect(isExpandableTool('grep')).toBe(true);
        expect(isExpandableTool('functions.grep:1')).toBe(true);
        expect(isExpandableTool('glob')).toBe(true);
        expect(isExpandableTool('functions.glob:1')).toBe(true);
        expect(isExpandableTool('websearch')).toBe(true);
        expect(isExpandableTool('todowrite')).toBe(true);
    });

    test('treats unknown custom tool names as expandable', () => {
        expect(isExpandableTool('custom-tool')).toBe(true);
        expect(isExpandableTool('functions.custom_tool')).toBe(true);
        expect(isExpandableTool('multi_tool_use.parallel:2')).toBe(true);
        expect(isStandaloneTool('custom-tool')).toBe(false);
    });

    test('treats empty or missing tool names as non-expandable', () => {
        expect(isExpandableTool('')).toBe(false);
        expect(isExpandableTool('   ')).toBe(false);
        expect(isExpandableTool(null)).toBe(false);
        expect(isExpandableTool(undefined)).toBe(false);
        expect(isStandaloneTool(undefined)).toBe(false);
    });
});
