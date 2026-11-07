import { describe, expect, test } from 'bun:test';
import { quotaGiftResetBridgePayload } from './quotaGiftResetRequest';
import { extractJsonBody } from './requestBodyTransport';

const payloadFor = async (body: { recordId: number; resetType: string; grantType?: string | null }) => {
  const request = new Request('https://openchamber.local/api/quota/zai-coding-plan/gift-reset/use', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return quotaGiftResetBridgePayload('zai-coding-plan', await extractJsonBody(request, undefined, 'POST'));
};

describe('VS Code webview gift reset request', () => {
  test('forwards the record grantType to the extension host', async () => {
    expect(await payloadFor({ recordId: 462029, resetType: 'WEEK', grantType: 'ACTIVITY' })).toEqual({
      providerId: 'zai-coding-plan',
      recordId: 462029,
      resetType: 'WEEK',
      grantType: 'ACTIVITY',
    });
  });

  test('keeps an omitted grantType omitted, so the provider falls back to GLOBAL', async () => {
    const payload = await payloadFor({ recordId: 462029, resetType: 'FIVE_HOUR' });

    expect(payload.grantType).toBeUndefined();
    expect(JSON.parse(JSON.stringify(payload))).not.toHaveProperty('grantType');
  });

  test('forwards an invalid grantType for the extension host to reject', async () => {
    expect((await payloadFor({ recordId: 1, resetType: 'WEEK', grantType: null })).grantType).toBeNull();
  });
});
