/** The bridge payload for `POST /api/quota/:providerId/gift-reset/use`. The extension host validates every value. */
export const quotaGiftResetBridgePayload = (
  providerId: string,
  body: { recordId?: unknown; resetType?: unknown; grantType?: unknown },
) => ({
  providerId,
  recordId: body.recordId,
  resetType: body.resetType,
  grantType: body.grantType,
});
