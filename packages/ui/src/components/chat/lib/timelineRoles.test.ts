import { describe, expect, test } from 'bun:test';
import type { SystemMessage, SyntheticMessage } from '@/lib/opencode/model';

import { isLabelledInjection, isSkippedTimelineMessage, isTimelineNoticeRole } from './timelineRoles';

const synthetic = (description?: string): SyntheticMessage => ({
    id: 'msg_1',
    sessionID: 'ses_1',
    role: 'synthetic',
    time: { created: 1 },
    text: '',
    ...(description === undefined ? {} : { description }),
});

const subagentReport: SyntheticMessage = {
    id: 'msg_2',
    sessionID: 'ses_1',
    role: 'synthetic',
    time: { created: 1 },
    text: '<subagent sessionID="ses_child" state="completed" description="review">\nLooks good\n</subagent>',
    description: 'review',
    metadata: { source: 'subagent', childID: 'ses_child', agent: 'general', state: 'completed' },
};

describe('timelineRoles', () => {
    test('synthetic is a notice role, skipped unless it is labelled or a subagent run', () => {
        expect(isTimelineNoticeRole('synthetic')).toBe(true);
        expect(isSkippedTimelineMessage(synthetic())).toBe(true);
        expect(isSkippedTimelineMessage(synthetic('   '))).toBe(true);
        expect(isSkippedTimelineMessage(synthetic('quota-retry · 第 2 轮 · 内部标记(不发给模型)'))).toBe(false);
        expect(isSkippedTimelineMessage(subagentReport)).toBe(false);
    });

    test('only labelled synthetic messages count as labelled injections', () => {
        expect(isLabelledInjection(synthetic('round 2'))).toBe(true);
        expect(isLabelledInjection(synthetic())).toBe(false);
        const systemMessage: SystemMessage = {
            id: 'msg_3', sessionID: 'ses_1', role: 'system', time: { created: 1 }, text: 'note',
        };
        expect(isLabelledInjection(systemMessage)).toBe(false);
    });
});
