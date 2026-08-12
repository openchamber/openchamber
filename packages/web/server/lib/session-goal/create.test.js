import { beforeEach, describe, expect, it, vi } from 'vitest';

const writeObjectiveMock = vi.fn(async () => undefined);
const generateSmallModelTextMock = vi.fn(async () => ({ text: '' }));

vi.mock('./objectives.js', () => ({
  GOAL_OBJECTIVE_CHAR_LIMIT: 5_000,
  writeObjective: writeObjectiveMock,
}));

vi.mock('../small-model/index.js', () => ({
  generateSmallModelText: generateSmallModelTextMock,
}));

const { buildGoalIntroText, createSessionGoal } = await import('./create.js');

describe('session goal creation', () => {
  beforeEach(() => {
    writeObjectiveMock.mockReset().mockResolvedValue(undefined);
    generateSmallModelTextMock.mockReset().mockResolvedValue({ text: '' });
  });

  it('writes the objective before patching active goal metadata', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true }));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock;
    try {
      const goal = await createSessionGoal({
        baseUrl: 'http://opencode.test',
        authHeaders: { Authorization: 'Bearer test' },
        sessionID: 'ses_123',
        directory: '/repo/app',
        objective: 'Finish and verify the migration',
        tokenBudget: 200_000,
        providerID: 'openai',
        modelID: 'gpt-5.5',
      });

      expect(writeObjectiveMock).toHaveBeenCalledWith('ses_123', 'Finish and verify the migration');
      expect(writeObjectiveMock.mock.invocationCallOrder[0]).toBeLessThan(fetchMock.mock.invocationCallOrder[0]);
      expect(goal).toMatchObject({ objective: '', objectiveFile: true, status: 'active', tokenBudget: 200_000 });
      expect(fetchMock).toHaveBeenCalledWith(
        'http://opencode.test/session/ses_123?directory=%2Frepo%2Fapp',
        expect.objectContaining({ method: 'PATCH' }),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('falls back to inline metadata when objective storage fails', async () => {
    writeObjectiveMock.mockRejectedValueOnce(new Error('disk unavailable'));
    const fetchMock = vi.fn(async () => ({ ok: true }));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock;
    try {
      await createSessionGoal({
        baseUrl: 'http://opencode.test',
        authHeaders: {},
        sessionID: 'ses_123',
        directory: '/repo/app',
        objective: 'Finish the migration',
        onWarning: vi.fn(),
      });

      const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(payload.metadata.openchamber.goal).toMatchObject({
        objective: 'Finish the migration',
        objectiveFile: false,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('drops a distilled objective written in another script', async () => {
    // 6,800 chars — over the mocked 5,000-char limit, so distillation runs.
    const longObjective = 'マイグレーションを完了し検証する。'.repeat(400);
    generateSmallModelTextMock.mockResolvedValueOnce({
      text: '저장소 구조를 정리하고 테스트를 통과시킨다',
    });
    const onWarning = vi.fn();
    const fetchMock = vi.fn(async () => ({ ok: true }));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock;
    try {
      await createSessionGoal({
        baseUrl: 'http://opencode.test',
        authHeaders: {},
        sessionID: 'ses_123',
        directory: '/repo/app',
        objective: longObjective,
        onWarning,
      });

      expect(generateSmallModelTextMock).toHaveBeenCalledOnce();
      const stored = writeObjectiveMock.mock.calls[0][1];
      expect(stored).not.toContain('저장소');
      expect(stored).toContain('objective trimmed for the auditor');
      expect(onWarning).toHaveBeenCalledWith(
        'goal objective distillation dropped: script mismatch with the objective',
        undefined,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('builds the same goal intro with an optional budget', () => {
    expect(buildGoalIntroText(null)).toContain('Goal mode is active for this session.');
    expect(buildGoalIntroText(200_000)).toContain('A token budget of 200000 tokens applies to this goal.');
  });
});
