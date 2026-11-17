import { GitNetworkOperationRequestError } from '@/lib/api/types';
import type { I18nKey, I18nParams } from '@/lib/i18n';

type Translate = (key: I18nKey, params?: I18nParams) => string;

export const gitRequestErrorMessage = (error: Error, t: Translate): string => (
  error instanceof GitNetworkOperationRequestError && error.code === 'REMOTE_URL_USERINFO'
    ? t('gitView.toast.remoteUrlUserinfo')
    : error.message
);
