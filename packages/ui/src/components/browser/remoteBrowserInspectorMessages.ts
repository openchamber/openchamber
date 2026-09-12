import type { I18nKey } from '@/lib/i18n';
import type { SurfaceInspectorErrorCode } from '@/lib/browser/remoteSurfaceInspectorProtocol';

export const remoteInspectorErrorKeys = {
  UNAVAILABLE: 'contextPanel.browser.remote.inspector.errorUnavailable',
  INVALID_REQUEST: 'contextPanel.browser.remote.inspector.errorInvalid',
  CAPTURE_GONE: 'contextPanel.browser.remote.inspector.errorCaptureGone',
  EVALUATION_FAILED: 'contextPanel.browser.remote.inspector.errorEvaluation',
  EVALUATION_TIMEOUT: 'contextPanel.browser.remote.inspector.errorTimeout',
  REQUEST_GONE: 'contextPanel.browser.remote.inspector.errorRequestGone',
  REQUEST_FAILED: 'contextPanel.browser.remote.inspector.errorRequest',
  CAPTURE_FAILED: 'contextPanel.browser.remote.inspector.errorCapture',
  CANCELLED: null,
  TIMEOUT: 'contextPanel.browser.remote.inspector.errorTimeout',
} satisfies Record<SurfaceInspectorErrorCode, I18nKey | null>;
