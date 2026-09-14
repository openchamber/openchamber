import { describe, expect, test } from 'bun:test';
import type { Part, ToolPart } from '@opencode-ai/sdk/v2';
import type { TurnActivityRecord } from '../../lib/turns/types';
import { getContextToolSummaryKind } from './toolRenderUtils';
import { projectToolSegmentRows } from './toolSegmentProjection';
import type { ToolSegmentRow } from './toolSegmentProjection';

const toolActivity = (
    id: string,
    tool: string,
    options: {
        status?: string;
        endedAt?: number;
        input?: Record<string, unknown>;
        messageId?: string;
    } = {}
): TurnActivityRecord => ({
    id,
    turnId: 'turn-1',
    messageId: options.messageId ?? 'message-1',
    partIndex: 0,
    kind: 'tool',
    endedAt: options.endedAt ?? 1,
    part: {
        id: `${id}-part`,
        type: 'tool',
        tool,
        state: {
            status: options.status ?? 'completed',
            input: options.input ?? {},
        },
    } as ToolPart,
});

const nonToolActivity = (
    id: string,
    kind: 'reasoning' | 'justification' = 'reasoning',
    messageId = 'message-1',
): TurnActivityRecord => ({
    id,
    turnId: 'turn-1',
    messageId,
    partIndex: 0,
    kind,
    endedAt: 1,
    part: {
        id: `${id}-part`,
        type: kind,
        text: 'hidden boundary',
    } as Part,
});

const expectRow = (
    row: ToolSegmentRow | undefined,
    expected: Partial<Extract<ToolSegmentRow, { type: 'context-tool-group' }>>
        | Partial<Extract<ToolSegmentRow, { type: 'tool-expandable' }>>
        | Partial<Extract<ToolSegmentRow, { type: 'tool-static' }>>,
): void => {
    expect(row).toBeTruthy();
    if (!row) return;
    if (expected.type !== undefined) expect(row.type).toBe(expected.type);
    if (expected.key !== undefined) expect(row.key).toBe(expected.key);
    if ('activities' in expected && expected.activities !== undefined && 'activities' in row) expect(row.activities).toEqual(expected.activities);
    if ('status' in expected && expected.status !== undefined && 'status' in row) expect(row.status).toBe(expected.status);
    if ('counts' in expected && expected.counts !== undefined && 'counts' in row) expect(row.counts).toEqual(expected.counts);
    if ('children' in expected && expected.children !== undefined && 'children' in row) expect(row.children).toEqual(expected.children);
    if ('activity' in expected && expected.activity !== undefined && 'activity' in row) expect(row.activity).toBe(expected.activity);
    if ('toolName' in expected && expected.toolName !== undefined && 'toolName' in row) expect(row.toolName).toBe(expected.toolName);
};

describe('getContextToolSummaryKind', () => {
    test('returns read/search/list only for canonical local context tool names', () => {
        expect(getContextToolSummaryKind('read')).toBe('read');
        expect(getContextToolSummaryKind('grep')).toBe('search');
        expect(getContextToolSummaryKind('glob')).toBe('search');
        expect(getContextToolSummaryKind('search')).toBe('search');
        expect(getContextToolSummaryKind(' Search ')).toBe('search');
        expect(getContextToolSummaryKind('list')).toBe('list');

        expect(getContextToolSummaryKind('view')).toBeNull();
        expect(getContextToolSummaryKind('file_read')).toBeNull();
        expect(getContextToolSummaryKind('websearch')).toBeNull();
        expect(getContextToolSummaryKind('codesearch')).toBeNull();
        expect(getContextToolSummaryKind('search_web')).toBeNull();
        expect(getContextToolSummaryKind('web-search')).toBeNull();
        expect(getContextToolSummaryKind('plugin.search')).toBeNull();
        expect(getContextToolSummaryKind('search:2')).toBeNull();
        expect(getContextToolSummaryKind('ripgrep')).toBeNull();
        expect(getContextToolSummaryKind('find')).toBeNull();
        expect(getContextToolSummaryKind('ls')).toBeNull();
        expect(getContextToolSummaryKind('webfetch')).toBeNull();
        expect(getContextToolSummaryKind('skill')).toBeNull();
        expect(getContextToolSummaryKind('todowrite')).toBeNull();
        expect(getContextToolSummaryKind('unknown')).toBeNull();
        expect(getContextToolSummaryKind('plugin.read')).toBeNull();
        expect(getContextToolSummaryKind('read:2')).toBeNull();
    });
});

describe('projectToolSegmentRows', () => {
    test('projects a single read as its existing static tool row', () => {
        const read = toolActivity('read-1', 'read');

        const rows = projectToolSegmentRows([read]);

        expect(rows).toHaveLength(1);
        expectRow(rows[0], {
            type: 'tool-static',
            key: 'static-read:read-1',
            activity: read,
            toolName: 'read',
        });
        expect(rows[0]?.renderSignature).toBe('tool-static:read-1:read:completed:1:filePath=;metadata.filePath=;file_path=;metadata.file_path=;path=;metadata.path=;offset=;metadata.offset=;line=;metadata.line=;pattern=;metadata.pattern=;query=;metadata.query=;include=;metadata.include=;dir=;metadata.dir=;directory=;metadata.directory=');
    });

    test('keeps canonical context singletons in their current ordinary presentation', () => {
        for (const toolName of ['grep', 'glob', 'search', 'list']) {
            const activity = toolActivity(`${toolName}-1`, toolName);
            const rows = projectToolSegmentRows([activity]);

            expect(rows).toHaveLength(1);
            expectRow(rows[0], {
                type: 'tool-expandable',
                key: `tool:${activity.id}`,
                activity,
            });
        }
    });

    test('changes from a static singleton to a first-child-keyed group when streaming a second context tool', () => {
        const read = toolActivity('read-1', 'read');
        const grep = toolActivity('grep-1', 'grep');

        const singleRows = projectToolSegmentRows([read]);
        const appendedRows = projectToolSegmentRows([read, grep]);

        expectRow(singleRows[0], { type: 'tool-static', key: 'static-read:read-1', activity: read, toolName: 'read' });
        expectRow(appendedRows[0], { type: 'context-tool-group', key: 'context-tool-group:read-1' });
    });

    test('groups contiguous canonical context tools across assistant messages in source order', () => {
        const read = toolActivity('read-1', 'read', { messageId: 'm1' });
        const grep = toolActivity('grep-1', 'grep', { messageId: 'm2' });
        const glob = toolActivity('glob-1', 'glob', { messageId: 'm2' });

        const rows = projectToolSegmentRows([read, grep, glob]);

        expect(rows).toHaveLength(1);
        expectRow(rows[0], {
            type: 'context-tool-group',
            key: 'context-tool-group:read-1',
            activities: [read, grep, glob],
            counts: { read: 1, search: 2, list: 0 },
        });
        expect(rows[0]?.type === 'context-tool-group' && rows[0].children.map((child) => child.id)).toEqual([
            'read-1',
            'grep-1',
            'glob-1',
        ]);
    });

    test('groups a two-child canonical context run across assistant messages', () => {
        const read = toolActivity('read-1', 'read', { messageId: 'm1' });
        const grep = toolActivity('grep-1', 'grep', { messageId: 'm2' });

        const rows = projectToolSegmentRows([read, grep]);

        expect(rows).toHaveLength(1);
        expectRow(rows[0], {
            type: 'context-tool-group',
            key: 'context-tool-group:read-1',
            activities: [read, grep],
            counts: { read: 1, search: 1, list: 0 },
        });
    });

    test('groups local search with read using grep-like hints in source order', () => {
        const search = toolActivity('search-1', 'search', { input: { pattern: 'useI18n', include: '*.tsx', path: 'src' } });
        const read = toolActivity('read-1', 'read', { input: { filePath: '/repo/src/App.tsx' } });

        const rows = projectToolSegmentRows([search, read]);

        expect(rows).toHaveLength(1);
        expectRow(rows[0], {
            type: 'context-tool-group',
            key: 'context-tool-group:search-1',
            activities: [search, read],
            counts: { read: 1, search: 1, list: 0 },
        });
        expect(rows[0]?.type === 'context-tool-group' && rows[0].children.map((child) => [child.id, child.kind, child.hint])).toEqual([
            ['search-1', 'search', 'useI18n · *.tsx · src'],
            ['read-1', 'read', 'App.tsx'],
        ]);
    });

    test('keeps five contiguous cross-message context tools in one group without a trailing singleton', () => {
        const activities = [
            toolActivity('read-1', 'read', { messageId: 'm1' }),
            toolActivity('read-2', 'read', { messageId: 'm1' }),
            toolActivity('grep-1', 'grep', { messageId: 'm1' }),
            toolActivity('glob-1', 'glob', { messageId: 'm1' }),
            toolActivity('read-3', 'read', { messageId: 'm2' }),
        ];

        const rows = projectToolSegmentRows(activities);

        expect(rows).toHaveLength(1);
        expectRow(rows[0], {
            type: 'context-tool-group',
            key: 'context-tool-group:read-1',
            activities,
            counts: { read: 3, search: 2, list: 0 },
        });
        expect(rows.some((row) => row.type === 'tool-static')).toBe(false);
        expect(rows[0]?.type === 'context-tool-group' && rows[0].children.map((child) => child.id)).toEqual([
            'read-1',
            'read-2',
            'grep-1',
            'glob-1',
            'read-3',
        ]);
    });

    test('flushes cross-message context runs at reasoning boundaries', () => {
        const read = toolActivity('read-1', 'read', { messageId: 'm1' });
        const reasoning = nonToolActivity('reasoning-1', 'reasoning', 'm2');
        const grep = toolActivity('grep-1', 'grep', { messageId: 'm2' });

        const rows = projectToolSegmentRows([read, reasoning, grep]);

        expect(rows.map((row) => row.type)).toEqual(['tool-static', 'tool-expandable']);
        expectRow(rows[0], { type: 'tool-static', key: 'static-read:read-1', activity: read, toolName: 'read' });
        expectRow(rows[1], { type: 'tool-expandable', key: 'tool:grep-1', activity: grep });
    });

    test('groups consecutive context tools and counts canonical summary kinds', () => {
        const activities = [
            toolActivity('read-1', 'read'),
            toolActivity('grep-1', 'grep'),
            toolActivity('glob-1', 'glob'),
            toolActivity('list-1', 'list'),
        ];

        const rows = projectToolSegmentRows(activities);

        expect(rows).toHaveLength(1);
        expectRow(rows[0], {
            type: 'context-tool-group',
            key: 'context-tool-group:read-1',
            activities,
            status: 'done',
            counts: { read: 1, search: 2, list: 1 },
        });
        expect(rows[0]?.renderSignature.includes('context-tool-group:read-1:done:read=1:search=2:list=1')).toBe(true);
    });

    test('projects context child view models in source order with child states and hints', () => {
        const rows = projectToolSegmentRows([
            toolActivity('read-1', 'read', { input: { filePath: '/repo/src/App.tsx' } }),
            toolActivity('grep-1', 'grep', { input: { pattern: 'useI18n', include: '*.tsx', path: 'src' } }),
            toolActivity('read-active', 'read', { status: 'running', endedAt: undefined, input: { filePath: '/repo/src/active.ts' } }),
            toolActivity('grep-error', 'grep', { status: 'error', input: { pattern: 'missingImport' } }),
        ]);

        expect(rows).toHaveLength(1);
        expect(rows[0].type).toBe('context-tool-group');
        if (rows[0].type !== 'context-tool-group') return;

        expect(rows[0].children.map((child) => [child.id, child.kind, child.state, child.hint])).toEqual([
            ['read-1', 'read', 'done', 'App.tsx'],
            ['grep-1', 'search', 'done', 'useI18n · *.tsx · src'],
            ['read-active', 'read', 'active', 'active.ts'],
            ['grep-error', 'search', 'error', 'missingImport'],
        ]);
    });

    test('keeps a late active context child in source order instead of moving it before completed children', () => {
        const rows = projectToolSegmentRows([
            toolActivity('read-1', 'read', { input: { filePath: '/repo/src/App.tsx' } }),
            toolActivity('grep-1', 'grep', { input: { pattern: 'useI18n' } }),
            toolActivity('glob-active', 'glob', { status: 'running', endedAt: undefined, input: { pattern: '**/*.tsx' } }),
        ]);

        expect(rows).toHaveLength(1);
        expect(rows[0].type).toBe('context-tool-group');
        if (rows[0].type !== 'context-tool-group') return;

        expect(rows[0].status).toBe('active');
        expect(rows[0].children.map((child) => [child.id, child.kind, child.state, child.hint])).toEqual([
            ['read-1', 'read', 'done', 'App.tsx'],
            ['grep-1', 'search', 'done', 'useI18n'],
            ['glob-active', 'search', 'active', '**/*.tsx'],
        ]);
    });

    test('changes render signature when visible context hints change', () => {
        const firstRows = projectToolSegmentRows([
            toolActivity('read-1', 'read', { input: { filePath: '/repo/src/first.ts' } }),
            toolActivity('grep-1', 'grep', { input: { pattern: 'first', include: '*.ts' } }),
        ]);
        const secondRows = projectToolSegmentRows([
            toolActivity('read-1', 'read', { input: { filePath: '/repo/src/second.ts' } }),
            toolActivity('grep-1', 'grep', { input: { pattern: 'second', include: '*.tsx' } }),
        ]);

        expect(firstRows).toHaveLength(1);
        expect(secondRows).toHaveLength(1);
        expect(firstRows[0].type).toBe('context-tool-group');
        expect(secondRows[0].type).toBe('context-tool-group');
        expect(firstRows[0].renderSignature).not.toBe(secondRows[0].renderSignature);
    });

    test('flushes context runs around expandable tools while keeping ordinary tools separate', () => {
        const read = toolActivity('read-1', 'read');
        const bash = toolActivity('bash-1', 'bash');
        const grep = toolActivity('grep-1', 'grep');

        const rows = projectToolSegmentRows([read, bash, grep]);

        expect(rows.map((row) => row.type)).toEqual(['tool-static', 'tool-expandable', 'tool-expandable']);
        expectRow(rows[0], { type: 'tool-static', key: 'static-read:read-1', activity: read, toolName: 'read' });
        expectRow(rows[1], { type: 'tool-expandable', key: 'tool:bash-1', activity: bash });
        expectRow(rows[2], { type: 'tool-expandable', key: 'tool:grep-1', activity: grep });
    });

    test('uses active group status when any child is active', () => {
        const rows = projectToolSegmentRows([
            toolActivity('read-1', 'read'),
            toolActivity('grep-1', 'grep', { status: 'running', endedAt: undefined }),
        ]);

        expect(rows).toHaveLength(1);
        expectRow(rows[0], { type: 'context-tool-group', status: 'active' });
    });

    test('uses active group status for every active child status', () => {
        for (const status of ['pending', 'running', 'started']) {
            const rows = projectToolSegmentRows([
                toolActivity(`read-${status}`, 'read'),
                toolActivity(`grep-${status}`, 'grep', { status }),
            ]);

            expect(rows).toHaveLength(1);
            expectRow(rows[0], { type: 'context-tool-group', status: 'active' });
        }
    });

    test('uses error group status ahead of active status', () => {
        const rows = projectToolSegmentRows([
            toolActivity('read-1', 'read', { status: 'running', endedAt: undefined }),
            toolActivity('grep-1', 'grep', { status: 'failed' }),
        ]);

        expect(rows).toHaveLength(1);
        expectRow(rows[0], { type: 'context-tool-group', status: 'error' });
    });

    test('uses error group status for every error child status', () => {
        for (const status of ['error', 'failed', 'aborted', 'timeout', 'cancelled']) {
            const rows = projectToolSegmentRows([
                toolActivity(`read-${status}`, 'read'),
                toolActivity(`grep-${status}`, 'grep', { status }),
            ]);

            expect(rows).toHaveLength(1);
            expectRow(rows[0], { type: 'context-tool-group', status: 'error' });
        }
    });

    test('uses done group status when every child is complete', () => {
        const rows = projectToolSegmentRows([
            toolActivity('read-1', 'read', { status: 'completed' }),
            toolActivity('grep-1', 'grep', { status: 'completed' }),
        ]);

        expect(rows).toHaveLength(1);
        expectRow(rows[0], { type: 'context-tool-group', status: 'done' });
    });

    test('treats reasoning and justification activities as boundaries without projecting boundary rows', () => {
        for (const kind of ['reasoning', 'justification'] as const) {
            const read = toolActivity(`read-before-${kind}`, 'read');
            const boundary = nonToolActivity(`${kind}-1`, kind);
            const grep = toolActivity(`grep-after-${kind}`, 'grep');

            const rows = projectToolSegmentRows([read, boundary, grep]);

            expect(rows.map((row) => row.type)).toEqual(['tool-static', 'tool-expandable']);
            expectRow(rows[0], {
                type: 'tool-static',
                key: `static-read:${read.id}`,
                activity: read,
                toolName: 'read',
            });
            expectRow(rows[1], {
                type: 'tool-expandable',
                key: `tool:${grep.id}`,
                activity: grep,
            });
            expect(rows.some((row) => 'activity' in row && row.activity === boundary)).toBe(false);
        }
    });

    test('skips standalone task rows and does not group through them', () => {
        const read = toolActivity('read-1', 'read');
        const task = toolActivity('task-1', 'task');
        const grep = toolActivity('grep-1', 'grep');

        const rows = projectToolSegmentRows([read, task, grep]);

        expect(rows.map((row) => row.type)).toEqual(['tool-static', 'tool-expandable']);
        expectRow(rows[0], { type: 'tool-static', activity: read, toolName: 'read' });
        expectRow(rows[1], { type: 'tool-expandable', activity: grep });
    });

    test('does not group non-context tools and preserves their singleton presentation', () => {
        const rows = projectToolSegmentRows([
            toolActivity('webfetch-1', 'webfetch'),
            toolActivity('skill-1', 'skill'),
            toolActivity('todo-1', 'todowrite'),
            toolActivity('unknown-1', 'unknown'),
        ]);

        expect(rows).toHaveLength(4);
        expect(rows.map((row) => row.type)).toEqual([
            'tool-expandable',
            'tool-static',
            'tool-expandable',
            'tool-expandable',
        ]);
    });

    test('keeps qualified and indexed canonical-looking tools separate', () => {
        const pluginRead = toolActivity('plugin-read-1', 'plugin.read');
        const indexedRead = toolActivity('read-2', 'read:2');
        const read = toolActivity('read-1', 'read');

        const rows = projectToolSegmentRows([pluginRead, read, indexedRead]);

        expect(rows.map((row) => row.type)).toEqual(['tool-static', 'tool-static', 'tool-static']);
        expectRow(rows[0], { type: 'tool-static', key: 'static-plugin.read:plugin-read-1', activity: pluginRead, toolName: 'plugin.read' });
        expectRow(rows[1], { type: 'tool-static', key: 'static-read:read-1', activity: read, toolName: 'read' });
        expectRow(rows[2], { type: 'tool-static', key: 'static-read:2:read-2', activity: indexedRead, toolName: 'read:2' });
    });

    test('flushes context runs around non-context tools while preserving their row', () => {
        const read = toolActivity('read-1', 'read');
        const webfetch = toolActivity('webfetch-1', 'webfetch');
        const grep = toolActivity('grep-1', 'grep');

        const rows = projectToolSegmentRows([read, webfetch, grep]);

        expect(rows.map((row) => row.type)).toEqual(['tool-static', 'tool-expandable', 'tool-expandable']);
        expectRow(rows[0], { type: 'tool-static', key: 'static-read:read-1', activity: read, toolName: 'read' });
        expectRow(rows[1], { type: 'tool-expandable', key: 'tool:webfetch-1', activity: webfetch });
        expectRow(rows[2], { type: 'tool-expandable', key: 'tool:grep-1', activity: grep });
    });

    test('flushes context runs at every supported ordinary expandable tool', () => {
        const read = toolActivity('read-1', 'read');
        const ordinaryTools = ['bash', 'shell', 'edit', 'write', 'apply_patch'];

        for (const tool of ordinaryTools) {
            const ordinary = toolActivity(`${tool}-1`, tool);
            const grep = toolActivity(`grep-after-${tool}`, 'grep');
            const rows = projectToolSegmentRows([read, ordinary, grep]);

            expect(rows.map((row) => row.type)).toEqual(['tool-static', 'tool-expandable', 'tool-expandable']);
            expectRow(rows[0], { type: 'tool-static', activity: read, toolName: 'read' });
            expectRow(rows[1], { type: 'tool-expandable', key: `tool:${ordinary.id}`, activity: ordinary });
            expectRow(rows[2], { type: 'tool-expandable', activity: grep });
        }
    });
});
