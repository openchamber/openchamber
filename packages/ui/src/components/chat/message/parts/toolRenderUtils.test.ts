import { describe, expect, test } from 'bun:test';

import { getToolMetadata } from '@/lib/toolHelpers';
import { isExpandableTool, isStaticTool, shouldShowToolParamSummary } from './toolRenderUtils';

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

    test('keeps static built-in tools static without parameter summaries', () => {
        expect(isStaticTool('read')).toBe(true);
        expect(shouldShowToolParamSummary('read')).toBe(false);
    });

    test('keeps todo tools static without parameter summaries', () => {
        expect(isStaticTool('todowrite')).toBe(true);
        expect(shouldShowToolParamSummary('todowrite')).toBe(false);
    });
});
