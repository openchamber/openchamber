export const PREVIEW_TARGET_ERROR_HEADER = 'x-openchamber-preview-target-error';

type PreviewTargetErrorCode = 'missing' | 'expired' | 'invalid-token';

export const getPreviewTargetErrorCode = (headers: Pick<Headers, 'get'>): PreviewTargetErrorCode | null => {
  const value = headers.get(PREVIEW_TARGET_ERROR_HEADER);
  return value === 'missing' || value === 'expired' || value === 'invalid-token'
    ? value
    : null;
};

export const getPreviewTargetRecoveryAction = (
  headers: Pick<Headers, 'get'>,
  recoveryAttempted: boolean,
): 'none' | 'retry-registration' | 'stop-retrying' => {
  if (!getPreviewTargetErrorCode(headers)) return 'none';
  return recoveryAttempted ? 'stop-retrying' : 'retry-registration';
};
