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
    const mergeSessionMetadata = vi.fn(async (_sessionID, _directory, mutate) => mutate({ other: true }));
    const goal = await createSessionGoal({
      openCodeApi: { mergeSessionMetadata },
      sessionID: 'ses_123',
      directory: '/repo/app',
      objective: 'Finish and verify the migration',
      tokenBudget: 200_000,
      providerID: 'openai',
      modelID: 'gpt-5.5',
    });

    expect(writeObjectiveMock).toHaveBeenCalledWith('ses_123', 'Finish and verify the migration');
    expect(writeObjectiveMock.mock.invocationCallOrder[0]).toBeLessThan(mergeSessionMetadata.mock.invocationCallOrder[0]);
    expect(goal).toMatchObject({ objective: '', objectiveFile: true, status: 'active', tokenBudget: 200_000 });
    expect(mergeSessionMetadata).toHaveBeenCalledWith('ses_123', '/repo/app', expect.any(Function));
    const metadata = await mergeSessionMetadata.mock.calls[0][2]({ other: true });
    expect(metadata).toMatchObject({ other: true, openchamber: { goal } });
  });

  it('falls back to inline metadata when objective storage fails', async () => {
    writeObjectiveMock.mockRejectedValueOnce(new Error('disk unavailable'));
    let writtenMetadata;
    const mergeSessionMetadata = vi.fn(async (_sessionID, _directory, mutate) => {
      writtenMetadata = await mutate({});
      return writtenMetadata;
    });
    await createSessionGoal({
      openCodeApi: { mergeSessionMetadata },
      sessionID: 'ses_123',
      directory: '/repo/app',
      objective: 'Finish the migration',
      onWarning: vi.fn(),
    });

    expect(writtenMetadata.openchamber.goal).toMatchObject({
      objective: 'Finish the migration',
      objectiveFile: false,
    });
  });

  it('builds the same goal intro with an optional budget', () => {
    expect(buildGoalIntroText(null)).toContain('Goal mode is active for this session.');
    expect(buildGoalIntroText(200_000)).toContain('A token budget of 200000 tokens applies to this goal.');
  });
});
