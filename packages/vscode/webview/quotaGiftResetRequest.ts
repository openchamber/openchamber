export const quotaGiftResetBridgePayload = (
  providerId: string,
  body: { recordId?: unknown; resetType?: unknown; grantType?: unknown },
) => ({
  providerId,
  recordId: body.recordId,
  resetType: body.resetType,
  grantType: body.grantType,
});
