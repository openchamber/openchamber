import { describe, expect, test } from 'bun:test';

import { getToolMetadata } from '@/lib/toolHelpers';
import { isExpandableTool, isStandaloneTool, isStaticTool, shouldShowToolParamSummary } from './toolRenderUtils';

describe('toolRenderUtils', () => {
    test('keeps custom namespaced tools expandable with parameter summaries', () => {
        expect(isExpandableTool('myplugin_bash')).toBe(true);
        expect(shouldShowToolParamSummary('myplugin_bash')).toBe(true);
    });

    test('does not collapse dotted custom tools into built-in tool metadata', () => {
        expect(isExpandableTool('plugin.bash')).toBe(true);
        expect(shouldShowToolParamSummary('plugin.bash')).toBe(true);
        expect(getToolMetadata('plugin.bash').displayName).toBe('Plugin bash');
    });

    test('keeps built-in custom-rendered tools from showing duplicate parameter summaries', () => {
        expect(isExpandableTool('bash')).toBe(true);
        expect(shouldShowToolParamSummary('bash')).toBe(false);
    });

    test('keeps task as both an expandable tool and an activity group boundary', () => {
        expect(isExpandableTool('task')).toBe(true);
        expect(isStandaloneTool('task')).toBe(true);
        expect(isStaticTool('task')).toBe(false);
        expect(shouldShowToolParamSummary('task')).toBe(false);
    });

    test('keeps static built-in tools static without parameter summaries', () => {
        expect(isStaticTool('read')).toBe(true);
        expect(shouldShowToolParamSummary('read')).toBe(false);
    });

    test('keeps todo tools static without parameter summaries', () => {
        expect(isStaticTool('todowrite')).toBe(true);
        expect(shouldShowToolParamSummary('todowrite')).toBe(false);
    });

    test('keeps known built-in metadata tools static unless explicitly marked otherwise', () => {
        const staticTools = [
            'list',
            'webfetch',
            'websearch',
            'codesearch',
            'skill',
            'plan_enter',
            'plan_exit',
            'StructuredOutput',
            'structuredoutput',
        ];

        for (const toolName of staticTools) {
            expect([toolName, isStaticTool(toolName)]).toEqual([toolName, true]);
            expect([toolName, isExpandableTool(toolName)]).toEqual([toolName, false]);
            expect([toolName, isStandaloneTool(toolName)]).toEqual([toolName, false]);
        }
    });

    test('keeps unknown tools expandable', () => {
        expect(isExpandableTool('unknown_custom_tool')).toBe(true);
        expect(isStaticTool('unknown_custom_tool')).toBe(false);
    });
});
